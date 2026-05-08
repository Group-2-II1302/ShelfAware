import { supabase } from "../supabaseClient";

type Shelf = {
    shelf_id: string;
    name: string;
    created_at: string;
};

export async function waitForNewShelf(
    timeoutMs = 90000,
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

        try {
            const res = await fetch("/api/shelves", {
                headers
            });

            if (!res.ok) {
                await sleep(pollIntervalMs);
                continue;
            }

            const data: { shelves: Shelf[] } = await res.json();

            const fresh = data.shelves.find((s) => {
                return (
                    new Date(s.created_at).getTime() >= setupStartedAt
                );
            });

            if (fresh) {
                return fresh.shelf_id;
            }

        } catch {
            // Ignore connectivity failures
        }

        await sleep(pollIntervalMs);
    }

    throw new Error("Provisioning timed out");
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}