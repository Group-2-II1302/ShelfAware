/**
 * Small UI formatters shared between dashboard and shelf detail
 * Insights views. Kept dependency-free so they can be imported from
 * either client or server code without pulling in SvelteKit.
 */

export function formatGrams(g: number): string {
  if (g >= 1000) return `${(g / 1000).toFixed(1)} kg`;
  return `${Math.round(g)} g`;
}

export function formatGramsPerDay(g: number): string {
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg/day`;
  if (g >= 10) return `${Math.round(g)} g/day`;
  return `${g.toFixed(1)} g/day`;
}

export function formatExpiredAgo(expiryDate: string): string {
  const expiry = new Date(expiryDate).getTime();
  const days = Math.floor((Date.now() - expiry) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Percentage delta for the period-over-period overview row. Tiny
 * noise rounds to "≈ same"; huge swings (last window was zero) are
 * capped at ±999 % so we never render absurd numbers.
 */
export function formatDelta(pct: number): string {
  if (Math.abs(pct) < 1) return "≈ same";
  const sign = pct > 0 ? "+" : "";
  const value = Math.abs(pct) > 999 ? (pct > 0 ? 999 : -999) : Math.round(pct);
  return `${sign}${value}%`;
}
