<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { setupState } from "$lib/stores";
  import { supabase } from "../../lib/supabaseClient";
  import { get } from "svelte/store";
  import { getShelf } from "../../lib/api";
  import ErrorBanner from "../../lib/components/ErrorBanner.svelte";

  let TIMEOUT = 60000;

  onMount(() => {
    let isDone = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    async function init() {
        const { shelfId } = get(setupState);

        if (!shelfId) {
            setupState.update(s => ({
                ...s,
                error: "Missing shelf ID"
            }));
            return
        }

        const { data: session } = await supabase.auth.getSession();

        const jwt = session.session?.access_token;

        const headers = {
            Authorization: `Bearer ${jwt}`
        };
    
        try {
            const before = await fetch("/api/shelves", { headers }).then(r => r.json());
            const baseline = new Set(
                before.shelves.map((s: any) => s.shelf_id)
            );

            timeoutId = setTimeout(() => {
                if (!isDone) {
                    setupState.update(s => ({
                        ...s,
                        error: "Device connection timed out"
                    }));
                }
            }, TIMEOUT);

            const poll = async () => {
                while (!isDone) {
                    const now = await fetch("/api/shelves", {headers }).then(r => r.json());

                    const fresh = now.shelves.find(
                        (s: any) => !baseline.has(s.shelf_id)
                    );

                    if (fresh) {
                        isDone = true;
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
            };

            poll();

        } catch (e) {
            setupState.update(s => ({
                ...s,
                error: "Failed to poll shelves"
            }));
        }
    }

    init();

    return () => {
        isDone = true;
        if (timeoutId) clearTimeout(timeoutId);
    };
  });
</script>

<ErrorBanner
  message={$setupState.error}
  action={{ type: "RETRY_CONNECTING" }}
/>

<h2>Connecting device...</h2>
<p>Please wait while your shelf comes online.</p>