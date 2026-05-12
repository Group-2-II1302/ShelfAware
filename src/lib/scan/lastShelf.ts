/*
  Tiny localStorage shim for remembering the shelf the user most
  recently targeted with a scan. Used by /scan-item to fast-path
  past the shelf picker and by /scan/barcode to record on entry.

  SSR-safe: every accessor guards on `typeof window`. Failures (quota,
  privacy mode, disabled storage) are swallowed because none of this
  is critical — the worst case is the user sees the picker once more.
*/

const KEY = "shelfaware:last-shelf-id";

export function getLastShelfId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastShelfId(shelfId: string | null | undefined): void {
  if (typeof window === "undefined") return;
  if (!shelfId) return;
  try {
    window.localStorage.setItem(KEY, shelfId);
  } catch {
    /* ignore */
  }
}

export function clearLastShelfId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
