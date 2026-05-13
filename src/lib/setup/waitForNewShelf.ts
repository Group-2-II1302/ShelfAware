import { supabase } from "../supabaseClient";
import { BACKEND_URL } from "../config";

type Shelf = {
  shelf_id: string;
  name: string;
  created_at: string;
};

/*
  Provisioning poller. 

  Snapshot-diff against the user's current shelves (per the contract):
  read the set of shelf_ids before the user goes to the captive portal,
  then poll until a shelf_id appears that wasn't in the baseline. This
  is robust against client clock skew, daylight-saving rollovers, and
  unrelated invites arriving mid-flow — none of which a created_at
  timestamp filter would survive.
*/
export type PollOutcome = "ok" | "fail";

export async function waitForNewShelf(
  signal: AbortSignal,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onProgress?: (outcome: PollOutcome) => void;
  } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 240_000; // 4 minutes
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const onProgress = opts.onProgress;

  const baseline = await fetchShelfIds();

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new DOMException("Polling aborted", "AbortError");
    }

    try {
      const ids = await fetchShelfIds();
      const fresh = [...ids].find((id) => !baseline.has(id));
      onProgress?.("ok");
      if (fresh) {
        console.log("[setup] detected fresh shelf:", fresh);
        return fresh;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      /*
        Network / auth-not-ready / transient 401 etc. — keep polling.
        The user is mid WiFi-flop during captive-portal handoff so
        these are expected. Logged for diagnostics only.
      */
      console.warn("[setup] poll iteration failed:", e?.message ?? e);
      onProgress?.("fail");
    }

    await sleep(pollIntervalMs, signal);
  }

  throw new Error("Provisioning timed out");
}

/*
  Single poll request. Re-reads the session each call so a token
  refresh during a long poll picks up automatically. Returns the
  current set of shelf_ids on success, throws on transient failure.
*/
async function fetchShelfIds(): Promise<Set<string>> {
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData.session?.access_token;
  if (!jwt) throw new Error("AUTH_NOT_READY");

  const res = await fetch(`${BACKEND_URL}/shelves`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`SHELVES_FETCH_FAILED status=${res.status} ${bodySnippet}`);
  }

  let body: { shelves?: Shelf[] };
  try {
    body = await res.json();
  } catch (jsonErr: any) {
    throw new Error(
      `SHELVES_PARSE_FAILED status=${res.status} ${jsonErr?.message ?? jsonErr}`,
    );
  }

  return new Set((body.shelves ?? []).map((s) => s.shelf_id));
}

/*
  Promise-based sleep that respects the abort signal so a manual
  cancel doesn't wait the full poll interval before throwing.
*/
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Polling aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Polling aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
