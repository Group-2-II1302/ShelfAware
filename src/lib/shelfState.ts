/**
 * Frontend mapping between the backend-computed `state` value (a clamped
 * float in [0, 1] representing slot fullness) and the canonical UX
 * buckets defined in the hardware doc.
 *
 * Bucket boundaries are intentionally a frontend concern: changing them
 * is a UX decision and should re-bucket every existing reading at render
 * time without any backend/schema work.
 *
 * Confirm exact thresholds with the hardware spec before locking in.
 */

export type StateBucket = "empty" | "low" | "half" | "mostly_full" | "full";

export function bucketFromState(state: number | null): StateBucket | null {
  if (state === null) return null;
  if (state >= 0.95) return "full";
  if (state >= 0.65) return "mostly_full";
  if (state >= 0.35) return "half";
  if (state >= 0.1) return "low";
  return "empty";
}

export const BUCKET_LABEL: Record<StateBucket, string> = {
  empty: "Empty",
  low: "Low",
  half: "Half",
  mostly_full: "Mostly Full",
  full: "Full",
};

export const NOT_CALIBRATED_LABEL = "Not calibrated";

/**
 * Recompute `state` on the fly from a slot's current weight and the
 * product's calibration. Returns null when full_weight_g is missing —
 * we genuinely can't compute fullness without a "full" reference.
 *
 * Mirrors the backend formula: clamp((est_grams - tare) / (full - tare), 0, 1)
 */
export function computeState(
  currentWeightG: number | null,
  fullWeightG: number | null,
  tareWeightG: number | null,
): number | null {
  if (
    fullWeightG === null ||
    fullWeightG === undefined ||
    currentWeightG === null ||
    currentWeightG === undefined
  ) {
    return null;
  }
  const tare = tareWeightG ?? 0;
  const denom = fullWeightG - tare;
  if (denom <= 0) return null;
  const ratio = (currentWeightG - tare) / denom;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}
