import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SLOTS_PER_SHELF, getZoneForSlot, type ZoneId } from "$lib/shelf";
import { computeState } from "$lib/shelfState";

/*
  Force the alert generator to re-run right now instead of waiting for
  the every-minute pg_cron tick. Used after user-initiated edits so
  the inbox / toast updates feel instant. Failures are logged but not
  propagated — alerts will catch up on the next cron tick anyway.
*/
async function regenerateAlertsNow(supabase: SupabaseClient): Promise<void> {
  const { error: rpcErr } = await supabase.rpc("generate_alerts");
  if (rpcErr) {
    console.warn(
      "[shelf actions] generate_alerts RPC failed (will retry via cron):",
      rpcErr.message,
    );
  }
}
import {
  computeInsights,
  resolveRange,
  type AlertRow,
  type ExpiryRow,
  type InsightItemMeta,
  type LogRow,
} from "$lib/insights";

type FilledSlot = {
  scale_index: number;
  zone: ZoneId;
  status: "filled";
  item: {
    id: string;
    barcode: string;
    expiry_date: string | null;
    product_name: string | null;
    brand: string | null;
    image_url: string | null;
    full_weight_g: number | null;
    /**
     * Tare weight (empty container) from product_catalog. Carried
     * through so the client can recompute fullness in response to
     * live shelf_items updates without an extra round trip.
     */
    tare_weight_g: number | null;
    current_weight_g: number | null;
    /**
     * Free-form OFF metadata (nutriments, ingredients, allergens, etc.)
     * captured at scan time. May be null on items added before this
     * field was being persisted; consumers should treat absent keys as
     * "data not available" rather than "zero".
     */
    nutrition_facts: Record<string, unknown> | null;
    /**
     * Recomputed-on-the-fly fullness from current_weight_g and the
     * joined product_catalog (full_weight_g / tare_weight_g). Null when
     * full_weight_g is missing — render as "Not calibrated".
     */
    state: number | null;
  };
};

type EmptySlot = {
  scale_index: number;
  zone: ZoneId;
  status: "empty";
};

export type ShelfSlot = FilledSlot | EmptySlot;

export const load: PageServerLoad = async ({
  locals,
  params,
  depends,
  url,
}) => {
  /*
    Tag this load so realtime weight_logs events on the client can
    refresh the shelf without nuking unrelated cached data.
  */
  depends("app:shelf-detail");

  const shelfId = params.shelf_id;
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user) {
    throw redirect(303, "/login");
  }

  /*
    Verify user belongs to this shelf
  */
  const { data: membership, error: membershipError } = await locals.supabase
    .from("shelf_members")
    .select("id")
    .eq("user_id", user.id)
    .eq("shelf_id", shelfId)
    .maybeSingle();

  if (membershipError) {
    throw error(500, membershipError.message);
  }

  if (!membership) {
    throw error(403, "Shelf access denied");
  }

  /*
    Load shelf metadata
  */
  const { data: shelf, error: shelfError } = await locals.supabase
    .from("shelves")
    .select("id, name")
    .eq("id", shelfId)
    .single();

  if (shelfError) {
    throw error(500, shelfError.message);
  }

  /*
    Load shelf items + product names + calibration weights.
    shelf_items.barcode → product_catalog.barcode

    We pull full_weight_g and tare_weight_g so we can recompute the
    `state` (fullness ratio) per slot at request time. Backend may
    later mirror state onto shelf_items; if/when that lands we can
    drop the recompute.
  */
  const { data: items, error: itemsError } = await locals.supabase
    .from("shelf_items")
    .select(
      `
        id,
        barcode,
        expiry_date,
        scale_index,
        current_weight_g,
        created_at,
        product_catalog (
          product_name,
          brand,
          image_url,
          full_weight_g,
          tare_weight_g,
          nutrition_facts
        )
      `,
    )
    .eq("shelf_id", shelfId)
    .order("created_at", { ascending: true });

  if (itemsError) {
    throw error(500, itemsError.message);
  }

  /*
    Build a fixed-length slot grid keyed by scale_index. The hardware
    layout is constant (see $lib/shelf), so we know how many slots to
    render up front; missing scale_index values render as empty slots.

    If two items share a scale_index (shouldn't happen, but defensively),
    the first one returned by the ordered query above wins.
  */
  type CatalogJoin = {
    product_name: string;
    brand: string | null;
    image_url: string | null;
    full_weight_g: number | null;
    tare_weight_g: number | null;
    nutrition_facts: Record<string, unknown> | null;
  };

  const itemBySlot = new Map<number, FilledSlot["item"]>();
  /*
    Item metadata for the insights pipeline. Built in this same pass
    over shelf_items so we don't query the same rows twice. Filled
    even for items we end up discarding from the slot grid (duplicate
    scale_index), since insights still want to consider them.
  */
  const itemMeta = new Map<string, InsightItemMeta>();
  for (const item of items ?? []) {
    const skipForGrid = itemBySlot.has(item.scale_index);
    /*
      PostgREST returns the joined product_catalog as either a single
      object or an array depending on the relationship metadata, so
      handle both shapes.
    */
    const rawCatalog = item.product_catalog as
      | CatalogJoin
      | CatalogJoin[]
      | null;
    const catalog = Array.isArray(rawCatalog)
      ? (rawCatalog[0] ?? null)
      : rawCatalog;

    const currentWeightG = item.current_weight_g ?? null;
    const state = computeState(
      currentWeightG,
      catalog?.full_weight_g ?? null,
      catalog?.tare_weight_g ?? null,
    );

    if (!skipForGrid) {
      itemBySlot.set(item.scale_index, {
        id: item.id,
        barcode: item.barcode,
        expiry_date: item.expiry_date,
        product_name: catalog?.product_name ?? null,
        brand: catalog?.brand ?? null,
        image_url: catalog?.image_url ?? null,
        full_weight_g: catalog?.full_weight_g ?? null,
        tare_weight_g: catalog?.tare_weight_g ?? null,
        current_weight_g: currentWeightG,
        nutrition_facts: catalog?.nutrition_facts ?? null,
        state,
      });
    }

    itemMeta.set(item.id, {
      id: item.id,
      shelfId,
      scaleIndex: item.scale_index,
      name: catalog?.product_name || item.barcode || "Item",
      brand: catalog?.brand ?? null,
      imageUrl: catalog?.image_url ?? null,
      tareG: catalog?.tare_weight_g ?? null,
      fullG: catalog?.full_weight_g ?? null,
      currentG: currentWeightG,
      expiryDate: item.expiry_date,
      createdAt: (item as { created_at?: string | null }).created_at ?? null,
    });
  }

  const slots: ShelfSlot[] = Array.from({ length: SLOTS_PER_SHELF }, (_, i) => {
    const filled = itemBySlot.get(i);
    const zone = getZoneForSlot(i);
    if (filled) {
      return { scale_index: i, zone, status: "filled", item: filled };
    }
    return { scale_index: i, zone, status: "empty" };
  });

  /*
    Most-recent weight reading across all items on this shelf. We use
    this as a proxy for "did the Pi check in lately" — there's no
    explicit heartbeat today. Returns null when the shelf has no
    items, or when items exist but the Pi has never sent a reading.
    Realtime subscription on the client refines this without us
    having to poll the server.
  */
  const itemIds = (items ?? []).map((it) => it.id);

  /*
    ─── Insights pipeline (per-shelf) ──────────────────────────────────
    Mirrors the dashboard's household-wide pipeline, scoped to this
    shelf's item ids. Reuses the shared `computeInsights` helper so the
    two views can't drift out of sync. Range is taken from `?range=` to
    match the dashboard convention; defaults to 30d.

    All Supabase queries here run in parallel with each other and with
    the lastSyncedAt query below, so adding insights doesn't add a
    sequential roundtrip to the shelf page.
  */
  const { key: insightRangeKey, days: insightWindowDays } = resolveRange(
    url.searchParams.get("range"),
  );
  const windowMs = insightWindowDays * 86_400_000;
  const nowMs = Date.now();
  const windowStart = new Date(nowMs - windowMs);
  const prevWindowStart = new Date(nowMs - windowMs * 2);
  const prevWindowEnd = windowStart;

  type Result<T> = { data: T[] | null; error: { message: string } | null };

  /*
    `lastSyncedAt` powers the sync-status badge in the always-visible
    header, so we await it on the critical path. Everything else
    (the five heavy insights queries + utilization sample) streams
    via the Promise we return below.
  */
  let lastLogRes: {
    data: { recorded_at: string } | null;
    error: { message: string } | null;
  } = {
    data: null,
    error: null,
  };
  if (itemIds.length > 0) {
    lastLogRes = (await locals.supabase
      .from("weight_logs")
      .select("recorded_at")
      .in("item_id", itemIds)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()) as unknown as typeof lastLogRes;
  }
  const lastSyncedAt: string | null = lastLogRes.data?.recorded_at ?? null;
  if (lastLogRes.error) {
    // Don't fail the whole page on a sync-status hiccup — just
    // surface "Never connected" so the rest of the shelf still
    // renders. Most likely cause is a missing SELECT RLS policy
    // on weight_logs for shelf members.
    console.warn(
      "[shelf load] weight_logs query failed:",
      lastLogRes.error.message,
    );
  }

  /*
    Snapshot mutable state used inside the async closure so the page
    renders without waiting on Supabase here.
  */
  const itemMetaSnapshot = Array.from(itemMeta.values());
  const itemIdToSlot = new Map<string, number>();
  for (const meta of itemMetaSnapshot)
    itemIdToSlot.set(meta.id, meta.scaleIndex);
  const currentItemMetaSize = itemMeta.size;

  const insightsPromise = (async () => {
    let utilLogsRes: Result<{
      item_id: string;
      recorded_at: string;
      weight_g: number;
    }> = {
      data: [],
      error: null,
    };
    let currentLogsRes: Result<LogRow> = { data: [], error: null };
    let currentAlertsRes: Result<AlertRow> = { data: [], error: null };
    let prevLogsRes: Result<LogRow> = { data: [], error: null };
    let prevAlertsRes: Result<AlertRow> = { data: [], error: null };
    let prevExpiriesRes: Result<ExpiryRow> = { data: [], error: null };

    if (itemIds.length > 0) {
      [
        currentLogsRes,
        currentAlertsRes,
        prevLogsRes,
        prevAlertsRes,
        prevExpiriesRes,
        utilLogsRes,
      ] = await Promise.all([
        locals.supabase
          .from("weight_logs")
          .select("item_id, weight_g, recorded_at")
          .in("item_id", itemIds)
          .gte("recorded_at", windowStart.toISOString())
          .order("recorded_at", { ascending: true }) as unknown as Promise<
          Result<LogRow>
        >,
        locals.supabase
          .from("alerts")
          .select("item_id, alert_type, last_triggered_at")
          .in("item_id", itemIds)
          .eq("alert_type", "low_stock")
          .gte(
            "last_triggered_at",
            windowStart.toISOString(),
          ) as unknown as Promise<Result<AlertRow>>,
        locals.supabase
          .from("weight_logs")
          .select("item_id, weight_g, recorded_at")
          .in("item_id", itemIds)
          .gte("recorded_at", prevWindowStart.toISOString())
          .lt("recorded_at", prevWindowEnd.toISOString())
          .order("recorded_at", { ascending: true }) as unknown as Promise<
          Result<LogRow>
        >,
        locals.supabase
          .from("alerts")
          .select("item_id, last_triggered_at")
          .in("item_id", itemIds)
          .eq("alert_type", "low_stock")
          .gte("last_triggered_at", prevWindowStart.toISOString())
          .lt(
            "last_triggered_at",
            prevWindowEnd.toISOString(),
          ) as unknown as Promise<Result<AlertRow>>,
        locals.supabase
          .from("shelf_items")
          .select("id, expiry_date, current_weight_g")
          .in("id", itemIds)
          .gte("expiry_date", prevWindowStart.toISOString().slice(0, 10))
          .lt(
            "expiry_date",
            prevWindowEnd.toISOString().slice(0, 10),
          ) as unknown as Promise<Result<ExpiryRow>>,
        /*
          Utilization sparkline. Sample weight logs across both windows
          (previous + current) so the chart has continuity at the
          boundary. We only need one log per item per day to know
          whether the slot was occupied; bucketization happens below.
        */
        locals.supabase
          .from("weight_logs")
          .select("item_id, weight_g, recorded_at")
          .in("item_id", itemIds)
          .gte("recorded_at", prevWindowStart.toISOString())
          .order("recorded_at", { ascending: true }) as unknown as Promise<
          Result<{ item_id: string; recorded_at: string; weight_g: number }>
        >,
      ]);
    }

    const insights = computeInsights(
      itemMetaSnapshot,
      currentLogsRes.data ?? [],
      currentAlertsRes.data ?? [],
      prevLogsRes.data ?? [],
      prevAlertsRes.data ?? [],
      prevExpiriesRes.data ?? [],
      insightWindowDays,
      insightRangeKey,
    );

    /*
      ── Shelf utilization sparkline ──────────────────────────────────
      For each day in the current window, count how many *distinct*
      slots had any weight reading on that day. "Slot has a log today"
      stands in for "slot was in use today" — fine for a trend line.
    */
    const dayMs = 86_400_000;
    const utilByDay = new Map<number, Set<number>>();
    for (const log of utilLogsRes.data ?? []) {
      const day = Math.floor(new Date(log.recorded_at).getTime() / dayMs);
      const slot = itemIdToSlot.get(log.item_id);
      if (slot === undefined) continue;
      const set = utilByDay.get(day) ?? new Set<number>();
      set.add(slot);
      utilByDay.set(day, set);
    }
    const utilizationSeries: number[] = [];
    const startDay = Math.floor((nowMs - windowMs) / dayMs);
    const endDay = Math.floor(nowMs / dayMs);
    for (let d = startDay; d <= endDay; d++) {
      utilizationSeries.push(utilByDay.get(d)?.size ?? 0);
    }
    const utilizationAvg =
      utilizationSeries.length > 0
        ? utilizationSeries.reduce((s, v) => s + v, 0) /
          utilizationSeries.length
        : 0;
    const utilization = {
      series: utilizationSeries,
      avgFilled: Math.round(utilizationAvg * 10) / 10,
      currentFilled: currentItemMetaSize,
      totalSlots: SLOTS_PER_SHELF,
    };

    return { ...insights, utilization };
  })();

  return {
    shelf,
    slots,
    itemIds,
    lastSyncedAt,
    /*
      Streamed: SvelteKit flushes the synchronous parts of this
      response immediately, then sends the insights payload when the
      promise above resolves. The page wraps the Insights tab in a
      `{#await}` block with a skeleton fallback.
    */
    insights: insightsPromise,
  };
};

/*
  Shelf name length cap. Anything longer overflows the dashboard tile
  caption and clutters the bottom-nav title bar on mobile, so enforce
  it both on the server (defence-in-depth) and on the client input.
*/
const MAX_SHELF_NAME_LEN = 40;

export const actions: Actions = {
  /**
   * Rename a shelf. Trims, validates length, and relies on RLS to
   * ensure the caller is a member of the shelf.
   */
  renameShelf: async ({ request, locals, params }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { error: "Not authenticated" });
    }

    const shelfId = params.shelf_id;
    const formData = await request.formData();
    const rawName = formData.get("name")?.toString() ?? "";
    const name = rawName.trim();

    if (!name) {
      return fail(400, { rename: { error: "Name cannot be empty." } });
    }
    if (name.length > MAX_SHELF_NAME_LEN) {
      return fail(400, {
        rename: {
          error: `Name must be ${MAX_SHELF_NAME_LEN} characters or fewer.`,
        },
      });
    }

    const { error: updateError } = await locals.supabase
      .from("shelves")
      .update({ name })
      .eq("id", shelfId);

    if (updateError) {
      console.error("renameShelf failed:", updateError.message);
      return fail(500, { rename: { error: updateError.message } });
    }

    return { rename: { success: true, name } };
  },

  /**
   * Delete a shelf entirely. Cascade on shelf_items / weight_logs /
   * alerts FKs cleans up children. Redirects to the dashboard on
   * success so the user isn't left looking at a dead shelf page.
   */
  deleteShelf: async ({ locals, params }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { error: "Not authenticated" });
    }

    const shelfId = params.shelf_id;
    const { error: deleteError, count } = await locals.supabase
      .from("shelves")
      .delete({ count: "exact" })
      .eq("id", shelfId);

    if (deleteError) {
      console.error("deleteShelf failed:", deleteError.message);
      return fail(500, { delete: { error: deleteError.message } });
    }

    if (!count) {
      /*
        RLS hid the row or it was already gone — either way the
        client's view is stale, so kick them back to the dashboard.
      */
      console.warn(`deleteShelf: no rows deleted for shelf=${shelfId}`);
    }

    throw redirect(303, "/");
  },

  /**
   * Remove the shelf_items row at a given (shelf_id, scale_index).
   * Used by the per-slot "Delete" button. RLS gates the actual delete
   * (the user must be a member of the shelf), and the corresponding
   * delete policy on shelf_items mirrors the membership predicate
   * used by the existing UPDATE policy.
   */
  deleteItem: async ({ request, locals, params }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { error: "Not authenticated" });
    }

    const shelfId = params.shelf_id;
    const formData = await request.formData();
    const scaleIndexRaw = formData.get("scale_index")?.toString();
    const scaleIndex = parseInt(scaleIndexRaw ?? "", 10);

    if (isNaN(scaleIndex) || scaleIndex < 0) {
      return fail(400, { error: "Invalid slot." });
    }

    const { data: deletedRows, error: deleteError } = await locals.supabase
      .from("shelf_items")
      .delete()
      .eq("shelf_id", shelfId)
      .eq("scale_index", scaleIndex)
      .select("id");

    if (deleteError) {
      console.error("deleteItem failed:", deleteError.message);
      return fail(500, { error: deleteError.message });
    }

    if (!deletedRows || deletedRows.length === 0) {
      /*
        Either the slot was already empty (race with another tab) or
        RLS hid the row from us. Treat both as a no-op success — the
        page reload below will reflect the actual state either way.
      */
      console.warn(
        `deleteItem: no rows deleted for shelf=${shelfId} slot=${scaleIndex}`,
      );
    }

    return { success: true };
  },

  /**
   * Update the expiry date of a single shelf_items row. Used by the
   * inline edit affordance in the item details modal. Empty / blank
   * input clears the date. RLS on shelf_items scopes the write.
   */
  updateExpiry: async ({ request, locals, params }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { error: "Not authenticated" });
    }

    const shelfId = params.shelf_id;
    const formData = await request.formData();
    const itemId = formData.get("item_id")?.toString().trim();
    const expiryRaw = formData.get("expiry_date")?.toString().trim() ?? "";

    if (!itemId) {
      return fail(400, { editExpiry: { error: "Missing item id." } });
    }

    /*
      Empty string means "clear the date". Otherwise validate it's a
      real ISO date so we don't store garbage that breaks the
      Intl.DateTimeFormat call on render.
    */
    let expiryValue: string | null = null;
    if (expiryRaw.length > 0) {
      const d = new Date(expiryRaw);
      if (isNaN(d.getTime())) {
        return fail(400, {
          editExpiry: { error: "Enter a valid date." },
        });
      }
      expiryValue = expiryRaw;
    }

    const { error: updErr } = await locals.supabase
      .from("shelf_items")
      .update({ expiry_date: expiryValue })
      .eq("id", itemId)
      .eq("shelf_id", shelfId);

    if (updErr) {
      console.error("updateExpiry failed:", updErr.message);
      return fail(500, { editExpiry: { error: updErr.message } });
    }

    /*
      Re-evaluate alerts immediately so a newly-past expiry surfaces
      a toast/inbox entry without waiting for the next cron tick. The
      shelf_items trigger does this too, but awaiting the explicit
      RPC guarantees the alerts table has settled before we return.
    */
    await regenerateAlertsNow(locals.supabase);

    return { editExpiry: { success: true, expiry_date: expiryValue } };
  },

  /**
   * Update one or more product_catalog fields (product_name,
   * full_weight_g, tare_weight_g) for the product currently in a
   * given slot. Used by inline edits in the item details modal.
   * Catalog rows are shared across every shelf with that barcode,
   * so the modal warns the user before saving.
   */
  updateProduct: async ({ request, locals, params }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { error: "Not authenticated" });
    }

    const shelfId = params.shelf_id;
    const formData = await request.formData();
    const itemId = formData.get("item_id")?.toString().trim();
    const field = formData.get("field")?.toString().trim();
    const valueRaw = formData.get("value")?.toString() ?? "";

    if (!itemId) {
      return fail(400, { editProduct: { error: "Missing item id." } });
    }
    if (
      field !== "product_name" &&
      field !== "full_weight_g" &&
      field !== "tare_weight_g"
    ) {
      return fail(400, { editProduct: { error: "Unsupported field." } });
    }

    /*
      Look up the barcode for this shelf_items row. Catalog edits key
      off barcode, not item id. Scope to shelfId so RLS verifies
      membership.
    */
    const { data: itemRow, error: itemErr } = await locals.supabase
      .from("shelf_items")
      .select("barcode")
      .eq("id", itemId)
      .eq("shelf_id", shelfId)
      .maybeSingle();
    if (itemErr) {
      console.error("updateProduct: lookup failed:", itemErr.message);
      return fail(500, { editProduct: { error: itemErr.message } });
    }
    if (!itemRow?.barcode) {
      return fail(404, { editProduct: { error: "Item not found." } });
    }

    let payload: Record<string, unknown> = {};

    if (field === "product_name") {
      const name = valueRaw.trim();
      if (!name) {
        return fail(400, {
          editProduct: { error: "Name cannot be empty." },
        });
      }
      if (name.length > 120) {
        return fail(400, {
          editProduct: { error: "Name must be 120 characters or fewer." },
        });
      }
      payload = { product_name: name };
    } else {
      /*
        Weight fields. Empty string clears tare_weight_g (allowed),
        but full_weight_g must remain positive — anything else makes
        the slot uncalibrated, which we now actively avoid.
      */
      const trimmed = valueRaw.trim();
      if (trimmed === "") {
        if (field === "full_weight_g") {
          return fail(400, {
            editProduct: {
              error: "Full weight is required to keep the slot calibrated.",
            },
          });
        }
        payload = { tare_weight_g: null };
      } else {
        const n = parseFloat(trimmed);
        if (!Number.isFinite(n) || n < 0) {
          return fail(400, {
            editProduct: { error: "Enter a non-negative number." },
          });
        }
        if (field === "full_weight_g" && n <= 0) {
          return fail(400, {
            editProduct: { error: "Full weight must be greater than zero." },
          });
        }
        payload = { [field]: Math.round(n) };
      }
    }

    const { error: updErr } = await locals.supabase
      .from("product_catalog")
      .update(payload)
      .eq("barcode", itemRow.barcode);

    if (updErr) {
      console.error("updateProduct failed:", updErr.message);
      return fail(500, { editProduct: { error: updErr.message } });
    }

    /*
      Catalog edits change calibration (full / tare weight) which feeds
      into LOWSTOCK evaluation — the shelf_items trigger doesn't fire
      for product_catalog updates, so we must invoke generate_alerts
      explicitly here. Cheap (~tens of ms) and avoids the up-to-60s
      cron lag.
    */
    await regenerateAlertsNow(locals.supabase);

    return { editProduct: { success: true, ...payload } };
  },

  /**
   * Set / update `product_catalog.full_weight_g` for the product
   * currently in a given slot. Drives the "Calibrate now" affordance
   * on uncalibrated slot cards: lets the user retro-fit a weight on
   * items that were added before calibration was enforced (or where
   * OpenFoodFacts didn't return one). RLS on product_catalog already
   * scopes writes to the user's household.
   */
  calibrateItem: async ({ request, locals, params }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { error: "Not authenticated" });
    }

    const shelfId = params.shelf_id;
    const formData = await request.formData();
    const scaleIndexRaw = formData.get("scale_index")?.toString();
    const scaleIndex = parseInt(scaleIndexRaw ?? "", 10);
    const weightRaw = formData.get("full_weight_g")?.toString();
    const weight = parseFloat(weightRaw ?? "");

    if (isNaN(scaleIndex) || scaleIndex < 0) {
      return fail(400, { calibrate: { error: "Invalid slot." } });
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      return fail(400, {
        calibrate: { error: "Enter a positive weight in grams." },
      });
    }

    /*
      Resolve the barcode of the item currently in this slot. We need
      it to update the right product_catalog row; updating by item id
      isn't possible because calibration lives on the catalog, not
      the per-shelf row.
    */
    const { data: itemRow, error: itemErr } = await locals.supabase
      .from("shelf_items")
      .select("barcode")
      .eq("shelf_id", shelfId)
      .eq("scale_index", scaleIndex)
      .maybeSingle();

    if (itemErr) {
      console.error("calibrateItem: lookup failed:", itemErr.message);
      return fail(500, { calibrate: { error: itemErr.message } });
    }
    if (!itemRow?.barcode) {
      return fail(404, {
        calibrate: { error: "Slot is empty — nothing to calibrate." },
      });
    }

    const { error: updErr } = await locals.supabase
      .from("product_catalog")
      .update({ full_weight_g: Math.round(weight) })
      .eq("barcode", itemRow.barcode);

    if (updErr) {
      console.error("calibrateItem: update failed:", updErr.message);
      return fail(500, { calibrate: { error: updErr.message } });
    }

    /*
      Same reasoning as updateProduct: calibration changes can flip a
      slot's LOWSTOCK status, but the product_catalog write doesn't
      hit the shelf_items trigger. Run generate_alerts() now so the
      inbox / toast match what the user just changed.
    */
    await regenerateAlertsNow(locals.supabase);

    return { calibrate: { success: true } };
  },
};
