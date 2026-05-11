/**
 * Shared insights pipeline. Used by both the household-wide dashboard
 * (`/`) and the per-shelf detail page (`/shelves/[id]`).
 *
 * Why a single module: both pages need the same five derived
 * artefacts (consumed total, wasted list, fastest-consumed sparklines,
 * always-running-low frequency, previous-window deltas), and any drift
 * between them would be confusing for the user ("the dashboard says I
 * wasted 3 items, but my fridge shelf says 2"). Computing once here
 * keeps the definitions in one place.
 *
 * The caller is responsible for assembling the `InsightItemMeta` map
 * (which already happens during the shelf_items pass on each page),
 * picking the time range, and running the four fan-out queries against
 * Supabase. This module is pure data crunching — no Supabase or
 * SvelteKit dependencies — which keeps it easy to unit test later.
 */

export const INSIGHT_RANGES: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const INSIGHT_LIST_LIMIT = 3;
export const MIN_DATA_DAYS = 3;
export const SPARK_POINTS = 20;

export type InsightItemMeta = {
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

export type LogRow = {
  item_id: string;
  weight_g: number;
  recorded_at: string;
};

export type AlertRow = {
  item_id: string;
  alert_type?: string;
  last_triggered_at?: string;
};

export type ExpiryRow = {
  id: string;
  expiry_date: string | null;
  current_weight_g: number | null;
};

export type ConsumptionRow = {
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

export type RunningLowRow = {
  itemId: string;
  shelfId: string;
  scaleIndex: number;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  alertCount: number;
};

export type WastedRow = {
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

export type Overview = {
  consumedTotalG: number;
  consumedItemCount: number;
  wastedItemCount: number;
  lowStockAlertCount: number;
  delta: {
    consumedPct: number | null;
    wastedPct: number | null;
    lowStockPct: number | null;
  };
};

export type InsightsPayload = {
  range: string;
  availableRanges: string[];
  windowDays: number;
  daysOfHistory: number;
  minDataDays: number;
  overview: Overview;
  fastestConsumed: ConsumptionRow[];
  alwaysRunningLow: RunningLowRow[];
  wasted: WastedRow[];
  wastedTotalG: number;
  wastedItemCount: number;
  wastedWeightApproximate: boolean;
};

export function resolveRange(rangeParam: string | null | undefined): {
  key: string;
  days: number;
} {
  const key = rangeParam && rangeParam in INSIGHT_RANGES ? rangeParam : "30d";
  return { key, days: INSIGHT_RANGES[key] };
}

/**
 * Compute insights from raw inputs. All time arithmetic is done in
 * UTC milliseconds; callers don't have to align timezones.
 *
 * @param items       Item metadata for every item in scope (whole
 *                    household, or a single shelf).
 * @param currentLogs Weight logs in the current window, restricted to
 *                    the items above.
 * @param currentAlerts low_stock alerts in the current window.
 * @param prevLogs    Weight logs in the previous window (same width).
 * @param prevAlerts  low_stock alerts in the previous window.
 * @param prevExpiries shelf_items rows whose expiry_date falls inside
 *                    the previous window. Stand-in for historical
 *                    waste counts because we don't keep weight history
 *                    for deleted items.
 * @param windowDays  Width of the current window in days.
 */
export function computeInsights(
  items: Iterable<InsightItemMeta>,
  currentLogs: LogRow[],
  currentAlerts: AlertRow[],
  prevLogs: LogRow[],
  prevAlerts: AlertRow[],
  prevExpiries: ExpiryRow[],
  windowDays: number,
  rangeKey: string,
): InsightsPayload {
  const itemMeta = new Map<string, InsightItemMeta>();
  for (const it of items) itemMeta.set(it.id, it);

  const nowMs = Date.now();
  const todayMs = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const windowMs = windowDays * 86_400_000;

  /*
    Bucket weight logs per item, ordered ascending. We rely on the
    caller to have ordered the query, but defensively sort here too —
    if anything reshuffles them, downstream slope math breaks silently.
  */
  type LogPoint = { t: number; w: number };
  const logsByItem = new Map<string, LogPoint[]>();
  let earliestLog: number | null = null;
  for (const log of currentLogs) {
    const t = new Date(log.recorded_at).getTime();
    if (earliestLog === null || t < earliestLog) earliestLog = t;
    const arr = logsByItem.get(log.item_id) ?? [];
    arr.push({ t, w: log.weight_g });
    logsByItem.set(log.item_id, arr);
  }
  for (const arr of logsByItem.values()) arr.sort((a, b) => a.t - b.t);

  /*
    Consumption rate: only the *drops* are summed (refills bump weight
    up; we don't want those to cancel out real consumption). Items
    needing <2 points or <24h span are dropped — too noisy to rank.
  */
  const consumption: ConsumptionRow[] = [];
  for (const [itemId, points] of logsByItem) {
    if (points.length < 2) continue;
    const span = points[points.length - 1].t - points[0].t;
    if (span < 86_400_000) continue;

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

    const step = Math.max(1, Math.floor(points.length / SPARK_POINTS));
    const sparkline: number[] = [];
    for (let i = 0; i < points.length; i += step) {
      sparkline.push(points[i].w);
    }
    const lastW = points[points.length - 1].w;
    if (sparkline[sparkline.length - 1] !== lastW) sparkline.push(lastW);

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
    Always running low: low-stock alert frequency per item over the
    window. resolved_at is ignored — frequency matters more than
    current state for this list.
  */
  const countByItem = new Map<string, number>();
  for (const a of currentAlerts) {
    countByItem.set(a.item_id, (countByItem.get(a.item_id) ?? 0) + 1);
  }
  const runningLow: RunningLowRow[] = [];
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
  const alwaysRunningLow = runningLow.slice(0, INSIGHT_LIST_LIMIT);

  /*
    Wasted: items past expiry with weight remaining on the scale.
    When tare_weight_g is null we can't deduct the container, so the
    "remaining" is flagged approximate. The dashboard/shelf UIs hedge
    wording when this is true.
  */
  const wasted: WastedRow[] = [];
  let wastedTotalG = 0;
  let wastedAnyApproximate = false;

  for (const meta of itemMeta.values()) {
    if (!meta.expiryDate) continue;
    const expiryMs = new Date(meta.expiryDate).getTime();
    if (expiryMs >= todayMs) continue;
    if (todayMs - expiryMs > windowMs) continue;
    if (meta.currentG === null || meta.currentG <= 0) continue;

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
    Previous-period totals for the delta comparison.
  */
  const prevLogsByItem = new Map<string, LogPoint[]>();
  for (const log of prevLogs) {
    const t = new Date(log.recorded_at).getTime();
    const arr = prevLogsByItem.get(log.item_id) ?? [];
    arr.push({ t, w: log.weight_g });
    prevLogsByItem.set(log.item_id, arr);
  }
  for (const arr of prevLogsByItem.values()) arr.sort((a, b) => a.t - b.t);

  let prevConsumedG = 0;
  for (const points of prevLogsByItem.values()) {
    if (points.length < 2) continue;
    for (let i = 1; i < points.length; i++) {
      const drop = points[i - 1].w - points[i].w;
      if (drop > 0) prevConsumedG += drop;
    }
  }
  const prevWastedCount = prevExpiries.filter(
    (r) => (r.current_weight_g ?? 0) > 0,
  ).length;

  const consumedTotalG = consumption.reduce(
    (sum, c) => sum + c.gPerDay * c.daysObserved,
    0,
  );
  const lowStockAlertCount = runningLow.reduce((s, r) => s + r.alertCount, 0);

  function pctDelta(current: number, previous: number): number | null {
    if (previous === 0) return null;
    return ((current - previous) / previous) * 100;
  }

  const daysOfHistory =
    earliestLog === null
      ? 0
      : Math.floor((nowMs - earliestLog) / 86_400_000);

  return {
    range: rangeKey,
    availableRanges: Object.keys(INSIGHT_RANGES),
    windowDays,
    daysOfHistory,
    minDataDays: MIN_DATA_DAYS,
    overview: {
      consumedTotalG: Math.round(consumedTotalG),
      consumedItemCount: consumption.length,
      wastedItemCount: wasted.length,
      lowStockAlertCount,
      delta: {
        consumedPct: pctDelta(consumedTotalG, prevConsumedG),
        wastedPct: pctDelta(wasted.length, prevWastedCount),
        lowStockPct: pctDelta(lowStockAlertCount, prevAlerts.length),
      },
    },
    fastestConsumed,
    alwaysRunningLow,
    wasted: wasted.slice(0, INSIGHT_LIST_LIMIT),
    wastedTotalG: Math.round(wastedTotalG),
    wastedItemCount: wasted.length,
    wastedWeightApproximate: wastedAnyApproximate,
  };
}
