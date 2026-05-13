/**
 * Shared classification of alert rows for the inbox and the realtime
 * toast. Keeps the two UIs in lockstep — the urgency mapping, short
 * label, and accent palette are decided here once and consumed by
 * any view that surfaces an alert.
 *
 * `crit  → red    : expired food / depleted slots`
 * `warn  → amber  : expires within 2 days, or low_stock`
 * `ok    → matcha : everything else`
 */

export type AlertUrgency = "crit" | "warn" | "ok";

/**
 * Minimal shape we need to bucket an alert. The various callers each
 * pass a slightly different row representation, so accept the union.
 */
export type AlertClassifyInput = {
  alertType: string | null | undefined;
  daysToExpiry?: number | null;
};

export function classifyAlert(input: AlertClassifyInput): AlertUrgency {
  const type = (input.alertType ?? "").toUpperCase();
  if (type === "LOWSTOCK" || type === "LOW_STOCK") return "warn";
  /*
    Expiry alert: urgency depends on the time delta. If we don't know
    (no shelf item / no expiry on file), fall back to `warn` since
    the alert wouldn't have fired without a reason.
  */
  const d = input.daysToExpiry;
  if (d === null || d === undefined) return "warn";
  if (d < 0) return "crit";
  if (d <= 2) return "warn";
  return "ok";
}

/**
 * Short, human-readable category label shown alongside the body.
 */
export function shortAlertLabel(input: AlertClassifyInput): string {
  const type = (input.alertType ?? "").toUpperCase();
  if (type === "LOWSTOCK" || type === "LOW_STOCK") return "Low stock";
  const d = input.daysToExpiry;
  if (d === null || d === undefined) return "Heads up";
  if (d < 0) return "Expired";
  if (d === 0) return "Expires today";
  if (d <= 2) return "Expiring soon";
  return "Expiring";
}
