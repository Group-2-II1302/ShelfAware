import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { SLOTS_PER_SHELF, getZoneForSlot, type ZoneId } from "$lib/shelf";
import { computeState } from "$lib/shelfState";

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

export const load: PageServerLoad = async ({ locals, params, depends }) => {
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
  for (const item of items ?? []) {
    if (itemBySlot.has(item.scale_index)) {
      continue;
    }
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
  let lastSyncedAt: string | null = null;
  if (itemIds.length > 0) {
    const { data: lastLog, error: logErr } = await locals.supabase
      .from("weight_logs")
      .select("recorded_at")
      .in("item_id", itemIds)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (logErr) {
      // Don't fail the whole page on a sync-status hiccup — just
      // surface "Never connected" so the rest of the shelf still
      // renders. Most likely cause is a missing SELECT RLS policy
      // on weight_logs for shelf members.
      console.warn("[shelf load] weight_logs query failed:", logErr.message);
    }
    lastSyncedAt = lastLog?.recorded_at ?? null;
  }

  return {
    shelf,
    slots,
    itemIds,
    lastSyncedAt,
  };
};

export const actions: Actions = {
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
};
