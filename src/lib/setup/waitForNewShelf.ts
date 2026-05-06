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

    // Initial snapshot
    const beforeRes = await fetch("/api/shelves", { headers });

    if (!beforeRes.ok) {
        throw new Error("Failed to fetch initial shelf snapshot");
    }

    const beforeData: { shelves: Shelf[] } = await beforeRes.json();

    const baseline = new Set(beforeData.shelves.map(s => s.shelf_id));

    // Polling loop
    const setupStartedAt = Date.now();

    await sleep(2000);

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const res = await fetch("/api/shelves", { headers });

        if (!res.ok) {
        await sleep(pollIntervalMs);
        continue;
        }

        const data: { shelves: Shelf[] } = await res.json();

        // Find new shelf
        const fresh = data.shelves.find((s) => {
            return (
                !baseline.has(s.shelf_id) &&
                new Date(s.created_at).getTime() >= setupStartedAt
            );
    });

        if (fresh) {
        return fresh.shelf_id;
        }

        await sleep(pollIntervalMs);
    }

    throw new Error("Provisioning timed out");
}
    function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}