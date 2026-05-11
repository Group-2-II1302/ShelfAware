import type { PageServerLoad } from "./$types";
import { SLOTS_PER_SHELF } from "$lib/shelf";

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

const INSIGHT_RANGES: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const load: PageServerLoad = async ({ locals, depends, url }) => {
  /*
    Tag this load so the client can selectively refresh shelf+sync
    state in response to realtime events without invalidating
    everything on the page.
  */
  depends("app:shelves");

  const rangeParam = url.searchParams.get("range") ?? "30d";
  const insightRangeKey = rangeParam in INSIGHT_RANGES ? rangeParam : "30d";
  const insightWindowDays = INSIGHT_RANGES[insightRangeKey];

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
  type InsightItemMeta = {
    id: string;
    shelfId: string;
    scaleIndex: number;
    name: string;
    brand: string | null;
    imageUrl: string | null;
    tareG: number | null;
    fullG: number | null;
    currentG: number | null;
    expiryDate: string | null;
    createdAt: string | null;
  };
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

    Pulls the last INSIGHT_WINDOW_DAYS of weight_logs across every
    current item, then derives three things in-memory:
      1. consumption rate per item (g/day) for "eat through fastest"
      2. low-stock alert frequency over the same window
      3. wasted last 30 days = items past expiry whose current weight
         was still above tare_weight_g (i.e. product remained)

    We deliberately compute client-of-Supabase rather than via a SQL
    function so the logic stays visible alongside the dashboard load.
    If the dataset grows large enough that this gets slow, a materialized
    view (refreshed daily) is the natural next step.
  */
  const INSIGHT_WINDOW_DAYS = insightWindowDays;
  const INSIGHT_LIST_LIMIT = 3;
  const MIN_DATA_DAYS = 3; // below this, surface skeleton states client-side
  const windowMs = INSIGHT_WINDOW_DAYS * 86_400_000;
  const nowMs = Date.now();
  const windowStart = new Date(nowMs - windowMs);
  const prevWindowStart = new Date(nowMs - windowMs * 2);
  const prevWindowEnd = windowStart;

  type LogPoint = { t: number; w: number };
  const logsByItem = new Map<string, LogPoint[]>();
  let earliestLog: number | null = null;

  /*
    Fire all five insight queries (current logs + current alerts +
    previous-window logs + previous-window alerts + previous-window
    expiries) in parallel. None of them depend on each other — only on
    the item id list built above. This collapses what was previously a
    chain of ~5 sequential Supabase roundtrips into a single round of
    fan-out, which is the meaningful latency win during range switches.
  */
  type SupabaseQueryResult<T> = { data: T[] | null; error: { message: string } | null };
  type LogRow = { item_id: string; weight_g: number; recorded_at: string };
  type AlertRow = { item_id: string };
  type ExpiryRow = { id: string; expiry_date: string | null; current_weight_g: number | null };

  let currentLogsRes: SupabaseQueryResult<LogRow> = { data: [], error: null };
  let currentAlertsRes: SupabaseQueryResult<{
    item_id: string;
    alert_type: string;
    last_triggered_at: string;
  }> = { data: [], error: null };
  let prevLogsRes: SupabaseQueryResult<LogRow> = { data: [], error: null };
  let prevAlertsRes: SupabaseQueryResult<AlertRow> = { data: [], error: null };
  let prevExpiriesRes: SupabaseQueryResult<ExpiryRow> = { data: [], error: null };

  if (itemMeta.size > 0) {
    const itemIds = Array.from(itemMeta.keys());
    [
      currentLogsRes,
      currentAlertsRes,
      prevLogsRes,
      prevAlertsRes,
      prevExpiriesRes,
    ] = await Promise.all([
      locals.supabase
        .from("weight_logs")
        .select("item_id, weight_g, recorded_at")
        .in("item_id", itemIds)
        .gte("recorded_at", windowStart.toISOString())
        .order("recorded_at", { ascending: true }) as Promise<SupabaseQueryResult<LogRow>>,
      locals.supabase
        .from("alerts")
        .select("item_id, alert_type, last_triggered_at")
        .in("item_id", itemIds)
        .eq("alert_type", "low_stock")
        .gte("last_triggered_at", windowStart.toISOString()) as Promise<
        SupabaseQueryResult<{
          item_id: string;
          alert_type: string;
          last_triggered_at: string;
        }>
      >,
      locals.supabase
        .from("weight_logs")
        .select("item_id, weight_g, recorded_at")
        .in("item_id", itemIds)
        .gte("recorded_at", prevWindowStart.toISOString())
        .lt("recorded_at", prevWindowEnd.toISOString())
        .order("recorded_at", { ascending: true }) as Promise<SupabaseQueryResult<LogRow>>,
      locals.supabase
        .from("alerts")
        .select("item_id")
        .in("item_id", itemIds)
        .eq("alert_type", "low_stock")
        .gte("last_triggered_at", prevWindowStart.toISOString())
        .lt("last_triggered_at", prevWindowEnd.toISOString()) as Promise<SupabaseQueryResult<AlertRow>>,
      locals.supabase
        .from("shelf_items")
        .select("id, expiry_date, current_weight_g")
        .in("id", itemIds)
        .gte("expiry_date", prevWindowStart.toISOString().slice(0, 10))
        .lt("expiry_date", prevWindowEnd.toISOString().slice(0, 10)) as Promise<SupabaseQueryResult<ExpiryRow>>,
    ]);

    if (currentLogsRes.error) {
      console.warn(
        "[insights] weight_logs query failed:",
        currentLogsRes.error.message,
      );
    }

    for (const log of currentLogsRes.data ?? []) {
      const t = new Date(log.recorded_at).getTime();
      if (earliestLog === null || t < earliestLog) earliestLog = t;
      const arr = logsByItem.get(log.item_id) ?? [];
      arr.push({ t, w: log.weight_g });
      logsByItem.set(log.item_id, arr);
    }
  }

  /*
    Consumption rate: slope of weight vs time over the window, clamped
    to non-negative (we only care about how fast it's emptying, not
    restocks bumping weight back up). Items with <2 points or <24h of
    span are excluded — too noisy to rank.
  */
  type ConsumptionRow = {
    itemId: string;
    shelfId: string;
    scaleIndex: number;
    name: string;
    brand: string | null;
    imageUrl: string | null;
    gPerDay: number;
    daysObserved: number;
    sparkline: number[];
  };

  const consumption: ConsumptionRow[] = [];
  for (const [itemId, points] of logsByItem) {
    if (points.length < 2) continue;
    const span = points[points.length - 1].t - points[0].t;
    if (span < 86_400_000) continue; // need at least a day of data

    /*
      Total *decreases* in weight, ignoring increases (refills).
      Captures the user's consumption even when an item gets topped
      up mid-window without distorting the rate.
    */
    let totalDrop = 0;
    for (let i = 1; i < points.length; i++) {
      const delta = points[i - 1].w - points[i].w;
      if (delta > 0) totalDrop += delta;
    }

    const daysObserved = span / 86_400_000;
    const gPerDay = totalDrop / daysObserved;
    if (gPerDay <= 0) continue;

    const meta = itemMeta.get(itemId);
    if (!meta) continue;

    /*
      Down-sample to ~20 points for the sparkline. Pure cosmetic: at
      this resolution the visual is fine and the payload stays light.
    */
    const SPARK_POINTS = 20;
    const step = Math.max(1, Math.floor(points.length / SPARK_POINTS));
    const sparkline: number[] = [];
    for (let i = 0; i < points.length; i += step) {
      sparkline.push(points[i].w);
    }
    if (sparkline[sparkline.length - 1] !== points[points.length - 1].w) {
      sparkline.push(points[points.length - 1].w);
    }

    consumption.push({
      itemId,
      shelfId: meta.shelfId,
      scaleIndex: meta.scaleIndex,
      name: meta.name,
      brand: meta.brand,
      imageUrl: meta.imageUrl,
      gPerDay,
      daysObserved,
      sparkline,
    });
  }
  consumption.sort((a, b) => b.gPerDay - a.gPerDay);
  const fastestConsumed = consumption.slice(0, INSIGHT_LIST_LIMIT);

  /*
    "Always running low": count low-stock alerts per item over the
    window. Uses last_triggered_at so re-triggers within the window
    each contribute. resolved_at is ignored — we want raw frequency.
  */
  type RunningLowRow = {
    itemId: string;
    shelfId: string;
    scaleIndex: number;
    name: string;
    brand: string | null;
    imageUrl: string | null;
    alertCount: number;
  };
  const runningLow: RunningLowRow[] = [];

  if (itemMeta.size > 0) {
    if (currentAlertsRes.error) {
      console.warn(
        "[insights] alerts query failed:",
        currentAlertsRes.error.message,
      );
    }

    const countByItem = new Map<string, number>();
    for (const a of currentAlertsRes.data ?? []) {
      countByItem.set(a.item_id, (countByItem.get(a.item_id) ?? 0) + 1);
    }
    for (const [itemId, count] of countByItem) {
      const meta = itemMeta.get(itemId);
      if (!meta) continue;
      runningLow.push({
        itemId,
        shelfId: meta.shelfId,
        scaleIndex: meta.scaleIndex,
        name: meta.name,
        brand: meta.brand,
        imageUrl: meta.imageUrl,
        alertCount: count,
      });
    }
    runningLow.sort((a, b) => b.alertCount - a.alertCount);
  }
  const alwaysRunningLow = runningLow.slice(0, INSIGHT_LIST_LIMIT);

  /*
    Wasted last 30 days: items that expired within the window while
    still having weight on the scale. Without container (tare) weight
    we can't say exactly *how much* product remained, so the count is
    the primary signal and the gram estimate is best-effort:
      - if tare_weight_g is known, remaining = current - tare
      - otherwise we report the full on-scale weight, flagged on the
        row so the UI can hedge the wording

    Only counts currently-present items. Deleted items are gone; for
    true historical waste tracking we'd need a soft-delete or a
    dedicated waste_events table later.
  */
  type WastedRow = {
    itemId: string;
    shelfId: string;
    scaleIndex: number;
    name: string;
    brand: string | null;
    imageUrl: string | null;
    expiryDate: string;
    estimatedRemainingG: number;
    /** True when the gram estimate could not be tare-adjusted. */
    weightIsApproximate: boolean;
  };
  const wasted: WastedRow[] = [];
  let wastedTotalG = 0;
  let wastedAnyApproximate = false;

  for (const meta of itemMeta.values()) {
    if (!meta.expiryDate) continue;
    const expiryMs = new Date(meta.expiryDate).getTime();
    if (expiryMs >= todayMs) continue; // not expired yet
    if (todayMs - expiryMs > windowMs) continue; // outside window
    if (meta.currentG === null || meta.currentG <= 0) continue; // nothing left

    const remaining =
      meta.tareG !== null ? meta.currentG - meta.tareG : meta.currentG;
    if (remaining <= 0) continue;

    const approximate = meta.tareG === null;
    if (approximate) wastedAnyApproximate = true;

    wasted.push({
      itemId: meta.id,
      shelfId: meta.shelfId,
      scaleIndex: meta.scaleIndex,
      name: meta.name,
      brand: meta.brand,
      imageUrl: meta.imageUrl,
      expiryDate: meta.expiryDate,
      estimatedRemainingG: Math.round(remaining),
      weightIsApproximate: approximate,
    });
    wastedTotalG += remaining;
  }
  wasted.sort((a, b) => b.estimatedRemainingG - a.estimatedRemainingG);

  /*
    Data availability hint for the client's skeleton states. If the
    earliest log we have is recent, there isn't enough history yet
    for the insights to be trustworthy.
  */
  const daysOfHistory =
    earliestLog === null
      ? 0
      : Math.floor((Date.now() - earliestLog) / 86_400_000);

  /*
    ── Overview totals for the current window ───────────────────────
    Computed from data we already have in memory. "Consumed" sums the
    weight drops captured by the consumption rate calc; "wasted item
    count" comes straight from the inferred-waste list.
  */
  const consumedTotalG = consumption.reduce(
    (sum, c) => sum + c.gPerDay * c.daysObserved,
    0,
  );
  const consumedItemCount = consumption.length;

  /*
    ── Previous-period comparison ───────────────────────────────────
    Same width window, immediately preceding the current one. Used
    by the overview row to render deltas ("30 % less wasted than the
    previous N days"). Skipped entirely when there are no items, to
    spare a wasted query on first-run accounts.
  */
  type PrevTotals = {
    consumedG: number;
    wastedItemCount: number;
    lowStockAlerts: number;
  };
  let prev: PrevTotals | null = null;

  if (itemMeta.size > 0) {
    /*
      The three previous-window queries were already fired in parallel
      with the current-window queries above; here we just consume them.
      "Expired in window" stands in for waste-count comparison since we
      can't recover historical weight for items whose expiry has long
      since passed.
    */
    const prevLogsByItem = new Map<string, LogPoint[]>();
    for (const log of prevLogsRes.data ?? []) {
      const t = new Date(log.recorded_at).getTime();
      const arr = prevLogsByItem.get(log.item_id) ?? [];
      arr.push({ t, w: log.weight_g });
      prevLogsByItem.set(log.item_id, arr);
    }

    let prevConsumedG = 0;
    for (const points of prevLogsByItem.values()) {
      if (points.length < 2) continue;
      for (let i = 1; i < points.length; i++) {
        const drop = points[i - 1].w - points[i].w;
        if (drop > 0) prevConsumedG += drop;
      }
    }

    const prevWastedCount = (prevExpiriesRes.data ?? []).filter(
      (r) => (r.current_weight_g ?? 0) > 0,
    ).length;

    prev = {
      consumedG: prevConsumedG,
      wastedItemCount: prevWastedCount,
      lowStockAlerts: prevAlertsRes.data?.length ?? 0,
    };
  }

  function pctDelta(current: number, previous: number): number | null {
    if (previous === 0) return null; // can't divide; UI will hide delta
    return ((current - previous) / previous) * 100;
  }

  const overview = {
    consumedTotalG: Math.round(consumedTotalG),
    consumedItemCount,
    wastedItemCount: wasted.length,
    lowStockAlertCount: runningLow.reduce((s, r) => s + r.alertCount, 0),
    delta: {
      consumedPct: prev ? pctDelta(consumedTotalG, prev.consumedG) : null,
      wastedPct: prev ? pctDelta(wasted.length, prev.wastedItemCount) : null,
      lowStockPct: prev
        ? pctDelta(
            runningLow.reduce((s, r) => s + r.alertCount, 0),
            prev.lowStockAlerts,
          )
        : null,
    },
  };

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
    insights: {
      range: insightRangeKey,
      availableRanges: Object.keys(INSIGHT_RANGES),
      windowDays: INSIGHT_WINDOW_DAYS,
      daysOfHistory,
      minDataDays: MIN_DATA_DAYS,
      overview,
      fastestConsumed,
      alwaysRunningLow,
      wasted: wasted.slice(0, INSIGHT_LIST_LIMIT),
      wastedTotalG: Math.round(wastedTotalG),
      wastedItemCount: wasted.length,
      wastedWeightApproximate: wastedAnyApproximate,
    },
  };
};
