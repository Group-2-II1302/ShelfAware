<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { setupState } from "$lib/stores";
  import { supabase } from "../../lib/supabaseClient";
  import { get } from "svelte/store";

  let channel: any;

  onMount(async () => {
    const { shelfId } = get(setupState);

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

          if (shelf.last_seen) {
            setupState.update((s) => ({
              ...s,
              step: "success"
            }));
          }
        }
      )
      .subscribe();
  });

  onDestroy(() => {
    if (channel) {
      supabase.removeChannel(channel);
    }
  });
</script>

<h2>Connecting device...</h2>
<p>Please wait while your shelf comes online.</p>