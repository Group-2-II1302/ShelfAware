export const PI_BASE = "http://192.168.4.1";

export async function getPiHealth() {
  try {
    const res = await fetch(`${PI_BASE}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return null;

    return res.json();
  } catch {
    return null;
  }
}
