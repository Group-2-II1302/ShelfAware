import { supabase } from "../supabaseClient";

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
        throw new Error("Not authenticated");
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

            const res = await fetch("/api/shelves", {
                headers,
                signal
            });

            if (res.ok) {

                const data: { shelves: Shelf[] } = await res.json();

                const fresh = data.shelves.find((s) => {
                    return (
                        new Date(s.created_at).getTime() >= setupStartedAt
                    );
                });

                if (fresh) {
                    return fresh.shelf_id;
                }
            }

        } catch (e: any) {

            if (e.name === "AbortError") {
                throw e;
            }

            // Ignore transient connectivity issues
        }

        await sleep(pollIntervalMs);
    }

    throw new Error("Provisioning timed out");
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}