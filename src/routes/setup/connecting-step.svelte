<script lang="ts">
  import { onMount } from "svelte";
  import { setupState } from "$lib/stores";
  import { supabase } from "../../lib/supabaseClient";
  import ErrorBanner from "../../lib/components/ErrorBanner.svelte";

  let TIMEOUT = 60000;

  onMount(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    let stopped = false;

    async function run() {
        try {
            const { data: session } = await supabase.auth.getSession();

            const jwt = session.session?.access_token;

            if (!jwt) {
                setupState.update(s => ({
                    ...s,
                    error: "Not authenticated"
                }));
                return;
            }

            const headers = {
                Authorization: `Bearer ${jwt}`
            };
        
            const before = await fetch("/api/shelves", { headers }).then(r => r.json());
            const baseline = new Set(before.shelves.map((s: any) => s.shelf_id));

            timeoutId = setTimeout(() => {
                setupState.update(s => ({
                    ...s,
                    error: "Device connection timed out"
                }));
                stopped = true;
            }, TIMEOUT);

            while (!stopped) {
                const now = await fetch("/api/shelves", {headers }).then(r => r.json());
                
                const fresh = now.shelves.find(
                    (s: any) => !baseline.has(s.shelf_id)
                );

                if (fresh) {
                    clearTimeout(timeoutId);

                    setupState.update(s => ({
                        ...s,
                        shelfId: fresh.shelf_id,
                        step: "success"
                    }));

                    return;
                }

                await new Promise(r => setTimeout(r, 3000));
            }

        } catch (e) {
            setupState.update(s => ({
                ...s,
                error: "Failed to check shelf status"
            }));
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