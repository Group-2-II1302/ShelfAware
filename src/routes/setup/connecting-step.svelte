<script lang="ts">
  import { onMount } from "svelte";
  import { setupState } from "$lib/stores";
  import { supabase } from "../../lib/supabaseClient";
  import ErrorBanner from "../../lib/components/ErrorBanner.svelte";

  let TIMEOUT = 60000;

  type ShelfListResponse = {
        shelves: { shelf_id: string }[];
  };

  onMount(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    let stopped = false;

    async function run() {
        setupState.update(s => ({
            ...s,
            step: "waiting",
            error: null
        }));

        try {
            const { data } = await supabase.auth.getSession();

            const jwt = data.session?.access_token;

            if (!jwt) {
                setupState.set({
                    step: "error",
                    shelfId: undefined,
                    error: "Not authenticated"
                });
                return;
            }

            const headers = {
                Authorization: `Bearer ${jwt}`
            };
        
            const beforeRes = await fetch("/api/shelves", { headers });

            if (!beforeRes.ok) throw new Error("Failed initial fetch");

            const before: ShelfListResponse = await beforeRes.json();
            const baseline = new Set(before.shelves.map((s: any) => s.shelf_id));

            timeoutId = setTimeout(() => {
                setupState.set({
                    step: "error",
                    shelfId: undefined,
                    error: "Device connection timed out"
                });
                stopped = true;
            }, TIMEOUT);

            while (!stopped) {
                const res = await fetch("/api/shelves", {headers });
                
                if (!res.ok) throw new Error("Polling failed");

                const now: ShelfListResponse = await res.json();

                const fresh = now.shelves.find(
                    (s: any) => !baseline.has(s.shelf_id)
                );

                if (fresh && !stopped) {
                    clearTimeout(timeoutId);

                    setupState.set({
                        step: "success",
                        shelfId: fresh.shelf_id,
                        error: undefined
                        
                    });

                    return;
                }

                await new Promise(r => setTimeout(r, 3000));
            }

        } catch (e) {
            if (!stopped) {    
                setupState.set({
                    step: "error",
                    shelfId: undefined,
                    error: "Failed to check shelf status"
                });
            }
        }
    }

    run();

    return () => {
        stopped = true;
        if (timeoutId) clearTimeout(timeoutId);
    };
  });
</script>

<ErrorBanner
  message={$setupState.error}
/>

<h2>Connecting device...</h2>
<p>Please wait while your shelf comes online.</p>