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
    let channel: any;

    async function init() {
        const { shelfId } = get(setupState);

        if (!shelfId) {
            setupState.update(s => ({
                ...s,
                error: "Missing shelf ID"
            }));
            return
        }
    
        try {
            const shelf = await getShelf(shelfId);

            if (shelf.last_seen) {
                isDone = true;

                setupState.update(s => ({
                    ...s,
                    step: "success"
                }));

                return;
            }
        } catch (e) {
            console.warn("Inital shelf check failed", e);
        }
    
        timeoutId = setTimeout(() => {
            if (!isDone) {
                setupState.update(s => ({
                    ...s,
                    error: "Device connection timed out"
                }));
            }
        }, TIMEOUT);
    
        channel = supabase
        .channel("shelves-setup")
        .on(
            "postgres_changes",
            {
                event: "UPDATE",
                schema: "public",
                table: "shelves",
                filter: `id=eq.${shelfId}`
                },
                (payload) => {
                const shelf = payload.new;

                if (shelf.last_seen && !isDone) {
                    isDone = true;
                    clearTimeout(timeoutId);

                    setupState.update(s => ({
                        ...s,
                        step: "success"
                    }));
                }
            }
        )
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR") {
                setupState.update(s => ({
                    ...s,
                    error: "Realtime connection failed"
                }));
            }
        });
    }

    init();

    return () => {
        isDone = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (channel) supabase.removeChannel(channel);
    };
  });
</script>

<ErrorBanner
  message={$setupState.error}
  action={{ type: "RETRY_CONNECTING" }}
/>

<h2>Connecting device...</h2>
<p>Please wait while your shelf comes online.</p>