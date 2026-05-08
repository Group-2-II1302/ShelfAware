/**
 * Sync-status helpers for shelf devices (Raspberry Pi load cells).
 *
 * The Pi pushes weight readings to Supabase whenever it samples — so
 * the freshest weight_logs.recorded_at for a shelf is a reasonable
 * proxy for "did the device call home recently". We don't have an
 * explicit heartbeat / online ping today, so this is presence by
 * inference rather than a true liveness signal.
 *
 * The thresholds below assume continuous sampling (every few seconds).
 * If sampling becomes event-driven (only on weight change), widen
 * ONLINE_MS substantially or this UI will lie about offline shelves.
 */

/**
 * UX buckets for shelf hardware presence.
 *
 * `empty` and `awaiting` both correspond to a missing lastSeen, but
 * have very different meanings:
 *   - empty:    the shelf has no items, so the Pi has nothing to weigh
 *               and "offline" semantics don't apply.
 *   - awaiting: items exist but the Pi has never written a reading
 *               for them. Could be a fresh setup, or a sign that
 *               something on the device is broken.
 */
export type SyncBucket =
  | "online"
  | "idle"
  | "stale"
  | "offline"
  | "awaiting"
  | "empty";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const SYNC_THRESHOLDS = {
  ONLINE_MS: 2 * MINUTE,
  IDLE_MS: 30 * MINUTE,
  STALE_MS: 24 * HOUR,
} as const;

/**
 * Categorize a "last seen" timestamp into a UX bucket. Boundaries:
 *   < 2 min        → online    (green)
 *   2 min – 30 min → idle      (yellow)
 *   30 min – 24 h  → stale     (orange)
 *   > 24 h         → offline   (red)
 *   no timestamp + items       → awaiting (gray, items not yet read)
 *   no timestamp + no items    → empty    (gray, nothing on shelf)
 *
 * `hasItems` lets us distinguish the last two without mistaking an
 * unused shelf for a broken one.
 */
export function bucketFromLastSeen(
  lastSeen: string | Date | null | undefined,
  now: Date = new Date(),
  hasItems = true,
): SyncBucket {
  if (!lastSeen) return hasItems ? "awaiting" : "empty";
  const ts = typeof lastSeen === "string" ? new Date(lastSeen) : lastSeen;
  if (isNaN(ts.getTime())) return hasItems ? "awaiting" : "empty";

  const ageMs = now.getTime() - ts.getTime();
  if (ageMs < 0) {
    /*
      Future timestamp — almost always device clock skew. Treat it
      as "online" rather than null, since data IS arriving; the
      relative-time formatter below will say "just now" anyway.
    */
    return "online";
  }
  if (ageMs < SYNC_THRESHOLDS.ONLINE_MS) return "online";
  if (ageMs < SYNC_THRESHOLDS.IDLE_MS) return "idle";
  if (ageMs < SYNC_THRESHOLDS.STALE_MS) return "stale";
  return "offline";
}

export const BUCKET_LABEL: Record<SyncBucket, string> = {
  online: "Online",
  idle: "Idle",
  stale: "Stale",
  offline: "Offline",
  awaiting: "Awaiting first reading",
  empty: "Empty shelf",
};

/**
 * Short-form relative time, the kind of phrasing that fits inside
 * a status pill ("12 s ago", "5 min ago", "3 d ago"). Returns
 * "just now" for sub-5-second deltas to avoid jitter, and a fixed
 * "—" for null inputs so consumers can render unconditionally.
 */
export function formatRelative(
  lastSeen: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!lastSeen) return "—";
  const ts = typeof lastSeen === "string" ? new Date(lastSeen) : lastSeen;
  if (isNaN(ts.getTime())) return "—";

  const ageMs = Math.max(0, now.getTime() - ts.getTime());
  if (ageMs < 5 * SECOND) return "just now";
  if (ageMs < MINUTE) return `${Math.round(ageMs / SECOND)} s ago`;
  if (ageMs < HOUR) return `${Math.round(ageMs / MINUTE)} min ago`;
  if (ageMs < 24 * HOUR) return `${Math.round(ageMs / HOUR)} h ago`;
  return `${Math.round(ageMs / (24 * HOUR))} d ago`;
}
