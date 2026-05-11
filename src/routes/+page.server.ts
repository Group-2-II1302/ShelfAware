import type { PageServerLoad } from "./$types";
import { SLOTS_PER_SHELF } from "$lib/shelf";
import {
  computeInsights,
  resolveRange,
  type AlertRow,
  type ExpiryRow,
  type InsightItemMeta,
  type LogRow,
} from "$lib/insights";

const EXPIRY_WINDOW_DAYS = 7;
const ACTION_LIST_LIMIT = 5;

type ActionItem = {
  id: string;
  shelfId: string;
  shelfName: string;
  scaleIndex: number;
  name: string;
  daysToExpiry: number | null;
  currentWeightG: number | null;
  thresholdG: number | null;
};

export const load: PageServerLoad = async ({ locals, depends, url }) => {
  /*
    Tag this load so the client can selectively refresh shelf+sync
    state in response to realtime events without invalidating
    everything on the page.
  */
  depends("app:shelves");

  const { key: insightRangeKey, days: insightWindowDays } = resolveRange(
    url.searchParams.get("range"),
  );

  const [{ data: shelves, error }, { data: profile }] = await Promise.all([
    locals.supabase.from("shelves").select("id, name").order("name"),
    locals.supabase
      .from("profiles")
      .select("first_name")
      .eq("id", locals.user?.id ?? "")
      .maybeSingle(),
  ]);

  if (error) {
    throw error;
  }

  const firstName = profile?.first_name?.trim() || null;

  /*
    Compute "last seen" per shelf so the dashboard can render a sync
    badge alongside each name. The naive query is N+1 (one weight_logs
    lookup per shelf), but N is small (a household typically has 1–3
    shelves) and these run in parallel via Promise.all. If shelf
    counts grow we can move this to a Postgres view that pre-computes
    max(recorded_at) per shelf.
  */
  const shelvesWithSync = await Promise.all(
    (shelves ?? []).map(async (shelf) => {
      const { data: items } = await locals.supabase
        .from("shelf_items")
        .select("id")
        .eq("shelf_id", shelf.id);

      const itemIds = (items ?? []).map((it) => it.id);
      let lastSyncedAt: string | null = null;
      if (itemIds.length > 0) {
        const { data: lastLog } = await locals.supabase
          .from("weight_logs")
          .select("recorded_at")
          .in("item_id", itemIds)
          .order("recorded_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        lastSyncedAt = lastLog?.recorded_at ?? null;
      }

      return { ...shelf, lastSyncedAt, hasItems: itemIds.length > 0, itemIds };
    }),
  );

  /*
    Flat item_id → shelf_id index so the client can route incoming
    weight_logs realtime events to the right dashboard row without
    a round-trip. Computed here because the per-shelf itemIds were
    already in scope.
  */
  const itemShelfMap: Record<string, string> = {};
  for (const shelf of shelvesWithSync) {
    for (const id of shelf.itemIds) {
      itemShelfMap[id] = shelf.id;
    }
  }

  /*
    Build the "Now" action lists: items expiring within EXPIRY_WINDOW_DAYS
    (including already-expired) and items currently below their low-stock
    threshold. Joins product_catalog for a readable name; falls back to
    the barcode if no product entry exists yet.
  */
  const shelfNameById: Record<string, string> = {};
  for (const shelf of shelvesWithSync) {
    shelfNameById[shelf.id] = shelf.name;
  }

  const today = new Date(new Date().toISOString().split("T")[0]);
  const todayMs = today.getTime();

  let expiring: ActionItem[] = [];
  let lowStock: ActionItem[] = [];

  /*
    Item metadata captured while iterating shelf_items for the Now
    lists. Reused later by the Insights pipeline (consumption rate,
    waste detection, sparklines) so we don't query the same rows twice.
  */
  const itemMeta = new Map<string, InsightItemMeta>();

  /*
    Per-shelf rollups for the Shelves section cards. Lets each shelf row
    show fullness ("3 / 6 slots") and a "earliest expires" hint without
    a second query — we already iterate every shelf_item below for the
    Now lists.
  */
  /*
    Per-slot state for the folder-tile preview. Most-severe state per
    scale_index wins (expired > urgent > low > normal). Empty slots
    stay implicit (anything not in this map renders as a dashed outline).
  */
  type SlotState = "normal" | "low" | "urgent" | "expired";
  const shelfRollup: Record<
    string,
    {
      filledSlots: number;
      earliestExpiryDays: number | null;
      filledSet: Set<number>;
      slotStates: Map<number, SlotState>;
    }
  > = {};
  for (const shelf of shelvesWithSync) {
    shelfRollup[shelf.id] = {
      filledSlots: 0,
      earliestExpiryDays: null,
      filledSet: new Set(),
      slotStates: new Map(),
    };
  }

  const severity: Record<SlotState, number> = {
    normal: 0,
    low: 1,
    urgent: 2,
    expired: 3,
  };

  const allShelfIds = shelvesWithSync.map((s) => s.id);
  if (allShelfIds.length > 0) {
    const { data: items, error: itemsErr } = await locals.supabase
      .from("shelf_items")
      .select(
        "id, shelf_id, scale_index, barcode, expiry_date, current_weight_g, low_stock_threshold_g, created_at, product_catalog(product_name, brand, image_url, tare_weight_g, full_weight_g)",
      )
      .in("shelf_id", allShelfIds);

    if (itemsErr) {
      console.error("[dashboard] failed to load action items", itemsErr);
    }

    for (const row of items ?? []) {
      const rollup = shelfRollup[row.shelf_id];
      if (rollup) {
        if (
          typeof row.scale_index === "number" &&
          !rollup.filledSet.has(row.scale_index)
        ) {
          rollup.filledSet.add(row.scale_index);
          rollup.filledSlots += 1;
        }

        if (typeof row.scale_index === "number") {
          let state: SlotState = "normal";
          if (row.expiry_date) {
            const days = Math.ceil(
              (new Date(row.expiry_date).getTime() - todayMs) / 86_400_000,
            );
            if (days < 0) state = "expired";
            else if (days <= 2) state = "urgent";
          }
          if (
            state === "normal" &&
            row.low_stock_threshold_g !== null &&
            row.current_weight_g !== null &&
            row.current_weight_g <= row.low_stock_threshold_g
          ) {
            state = "low";
          }
          const prev = rollup.slotStates.get(row.scale_index) ?? "normal";
          if (severity[state] > severity[prev]) {
            rollup.slotStates.set(row.scale_index, state);
          }
        }

        if (row.expiry_date) {
          const days = Math.ceil(
            (new Date(row.expiry_date).getTime() - todayMs) / 86_400_000,
          );
          if (
            rollup.earliestExpiryDays === null ||
            days < rollup.earliestExpiryDays
          ) {
            rollup.earliestExpiryDays = days;
          }
        }
      }

      const product = Array.isArray(row.product_catalog)
        ? row.product_catalog[0]
        : row.product_catalog;
      const cat = product as
        | {
            product_name?: string | null;
            brand?: string | null;
            image_url?: string | null;
            tare_weight_g?: number | null;
            full_weight_g?: number | null;
          }
        | null;
      const name = cat?.product_name || row.barcode || "Item";

      itemMeta.set(row.id, {
        id: row.id,
        shelfId: row.shelf_id,
        scaleIndex: row.scale_index,
        name,
        brand: cat?.brand ?? null,
        imageUrl: cat?.image_url ?? null,
        tareG: cat?.tare_weight_g ?? null,
        fullG: cat?.full_weight_g ?? null,
        currentG: row.current_weight_g,
        expiryDate: row.expiry_date,
        createdAt: (row as { created_at?: string | null }).created_at ?? null,
      });

      const base: Omit<ActionItem, "daysToExpiry"> = {
        id: row.id,
        shelfId: row.shelf_id,
        shelfName: shelfNameById[row.shelf_id] ?? "Shelf",
        scaleIndex: row.scale_index,
        name,
        currentWeightG: row.current_weight_g,
        thresholdG: row.low_stock_threshold_g,
      };

      if (row.expiry_date) {
        const days = Math.ceil(
          (new Date(row.expiry_date).getTime() - todayMs) / 86_400_000,
        );
        if (days <= EXPIRY_WINDOW_DAYS) {
          expiring.push({ ...base, daysToExpiry: days });
        }
      }

      if (
        row.low_stock_threshold_g !== null &&
        row.current_weight_g !== null &&
        row.current_weight_g <= row.low_stock_threshold_g
      ) {
        lowStock.push({ ...base, daysToExpiry: null });
      }
    }

    /*
      Sort: most urgent first. Expiring uses ascending days (already
      expired = most negative = top). Low stock uses ascending absolute
      weight (emptiest first).
    */
    expiring.sort(
      (a, b) =>
        (a.daysToExpiry ?? Number.POSITIVE_INFINITY) -
        (b.daysToExpiry ?? Number.POSITIVE_INFINITY),
    );
    lowStock.sort(
      (a, b) =>
        (a.currentWeightG ?? Number.POSITIVE_INFINITY) -
        (b.currentWeightG ?? Number.POSITIVE_INFINITY),
    );
  }

  const expiringTotal = expiring.length;
  const lowStockTotal = lowStock.length;

  /*
    ─── Insights pipeline ─────────────────────────────────────────────
    Fan out all five insight queries (current + previous window logs,
    alerts, expiries) in parallel, then hand them to the shared
    `computeInsights` helper. The helper is also called by the per-
    shelf detail page so the two views can't drift.
  */
  const windowMs = insightWindowDays * 86_400_000;
  const nowMs = Date.now();
  const windowStart = new Date(nowMs - windowMs);
  const prevWindowStart = new Date(nowMs - windowMs * 2);
  const prevWindowEnd = windowStart;

  type Result<T> = { data: T[] | null; error: { message: string } | null };
  let currentLogsRes: Result<LogRow> = { data: [], error: null };
  let currentAlertsRes: Result<AlertRow> = { data: [], error: null };
  let prevLogsRes: Result<LogRow> = { data: [], error: null };
  let prevAlertsRes: Result<AlertRow> = { data: [], error: null };
  let prevExpiriesRes: Result<ExpiryRow> = { data: [], error: null };

  if (itemMeta.size > 0) {
    const insightItemIds = Array.from(itemMeta.keys());
    [currentLogsRes, currentAlertsRes, prevLogsRes, prevAlertsRes, prevExpiriesRes] =
      await Promise.all([
        locals.supabase
          .from("weight_logs")
          .select("item_id, weight_g, recorded_at")
          .in("item_id", insightItemIds)
          .gte("recorded_at", windowStart.toISOString())
          .order("recorded_at", { ascending: true }) as unknown as Promise<Result<LogRow>>,
        locals.supabase
          .from("alerts")
          .select("item_id, alert_type, last_triggered_at")
          .in("item_id", insightItemIds)
          .eq("alert_type", "low_stock")
          .gte("last_triggered_at", windowStart.toISOString()) as unknown as Promise<Result<AlertRow>>,
        locals.supabase
          .from("weight_logs")
          .select("item_id, weight_g, recorded_at")
          .in("item_id", insightItemIds)
          .gte("recorded_at", prevWindowStart.toISOString())
          .lt("recorded_at", prevWindowEnd.toISOString())
          .order("recorded_at", { ascending: true }) as unknown as Promise<Result<LogRow>>,
        locals.supabase
          .from("alerts")
          .select("item_id, last_triggered_at")
          .in("item_id", insightItemIds)
          .eq("alert_type", "low_stock")
          .gte("last_triggered_at", prevWindowStart.toISOString())
          .lt("last_triggered_at", prevWindowEnd.toISOString()) as unknown as Promise<Result<AlertRow>>,
        locals.supabase
          .from("shelf_items")
          .select("id, expiry_date, current_weight_g")
          .in("id", insightItemIds)
          .gte("expiry_date", prevWindowStart.toISOString().slice(0, 10))
          .lt("expiry_date", prevWindowEnd.toISOString().slice(0, 10)) as unknown as Promise<Result<ExpiryRow>>,
      ]);

    if (currentLogsRes.error) {
      console.warn(
        "[insights] weight_logs query failed:",
        currentLogsRes.error.message,
      );
    }
  }

  const insights = computeInsights(
    itemMeta.values(),
    currentLogsRes.data ?? [],
    currentAlertsRes.data ?? [],
    prevLogsRes.data ?? [],
    prevAlertsRes.data ?? [],
    prevExpiriesRes.data ?? [],
    insightWindowDays,
    insightRangeKey,
  );

  const shelvesEnriched = shelvesWithSync.map((s) => {
    const rollup = shelfRollup[s.id];
    return {
      ...s,
      filledSlots: rollup?.filledSlots ?? 0,
      totalSlots: SLOTS_PER_SHELF,
      earliestExpiryDays: rollup?.earliestExpiryDays ?? null,
      /*
        Per-slot state for the iOS-folder-style preview on the dashboard.
        Length SLOTS_PER_SHELF, indexed by scale_index. "empty" means no
        item in that slot; other values surface urgency so the tile
        encodes status without a separate text line.
      */
      slotStates: Array.from(
        { length: SLOTS_PER_SHELF },
        (_, i): "empty" | SlotState =>
          rollup?.filledSet.has(i)
            ? (rollup.slotStates.get(i) ?? "normal")
            : "empty",
      ),
    };
  });

  return {
    shelves: shelvesEnriched,
    itemShelfMap,
    firstName,
    actions: {
      expiring: expiring.slice(0, ACTION_LIST_LIMIT),
      lowStock: lowStock.slice(0, ACTION_LIST_LIMIT),
      expiringTotal,
      lowStockTotal,
      limit: ACTION_LIST_LIMIT,
      /*
        Counts broken down by bucket for the inline summary
        ("3 today, 2 this week" / "running out, low").
      */
      expiringBuckets: {
        expired: expiring.filter((i) => (i.daysToExpiry ?? 0) < 0).length,
        today: expiring.filter((i) => i.daysToExpiry === 0).length,
        soon: expiring.filter((i) => (i.daysToExpiry ?? 0) > 0).length,
      },
      lowStockBuckets: {
        empty: lowStock.filter(
          (i) => i.currentWeightG !== null && i.currentWeightG <= 0,
        ).length,
        low: lowStock.filter(
          (i) => i.currentWeightG === null || i.currentWeightG > 0,
        ).length,
      },
    },
    insights,
  };
};
