import { supabase } from "../supabaseClient";

const WORKER_URL =
  "https://shelfaware-backend.emanuel-diktonius.workers.dev";

type Shelf = {
    shelf_id: string;
    name: string;
    created_at: string;
};

export async function waitForNewShelf(
    signal: AbortSignal,
    timeoutMs = 900000,
    pollIntervalMs = 3000
): Promise<string> {

    const { data } = await supabase.auth.getSession();

    const jwt = data.session?.access_token;

    if (!jwt) {
        throw new Error("NOT_AUTHENTICATED");
    }

    const headers = {
        Authorization: `Bearer ${jwt}`
    };

    const setupStartedAt = Date.now();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (signal.aborted) {
            throw new Error("Polling aborted");
        }

        try {

            console.log("[setup] Polling worker..");

            const res = await fetch(`${WORKER_URL}/shelves`, {
                headers
            });

            console.log("[setup] Worker response status: ", res.status);

            let data: { shelves: Shelf[] } | null = null;

            try {
                data = await res.json();

                console.log("[setup] worker response body: ", data);
            } catch (jsonError) {
                console.warn("[setup] Failed to parse worker JSON:", jsonError);
            }

            if (res.status === 401) {
                // auth not ready yet → retry instead of failing
                await sleep(pollIntervalMs);
                continue;
            }

            if (res.ok && data) {

                const fresh = data.shelves.find((s) => {
                    return (
                        new Date(s.created_at).getTime() >= setupStartedAt
                    );
                });

                console.log("[setup] detected fresh shelf:", fresh);

                if (fresh) {
                    console.log("[setup] Detected fresh shelf:", fresh);

                    return fresh.shelf_id;
                }
            }

        } catch (e: any) {

            if (e.name === "AbortError") {
                console.log("[setup] polling aborted");
                throw e;
            }

            console.warn("[setup] polling failed:", e);
        }

        await sleep(pollIntervalMs);
    }

    throw new Error("Provisioning timed out");
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}