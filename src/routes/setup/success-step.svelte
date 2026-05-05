<script lang="ts">
  import { setupState } from "../../lib/setup/stores";
  import { get } from "svelte/store";
  import { goto } from "$app/navigation";
  import { supabase } from "../../lib/supabaseClient";

  async function finish() {
    const { shelfId } = get(setupState);

    if (!shelfId) {
        console.error("Missing shelfId");
        return;
    }

    const { data: session } = await supabase.auth.getSession();
    const jwt = session.session?.access_token;

    const res = await fetch(`/api/shelves/${shelfId}`, {
        headers: {
            Authorization: `Bearer ${jwt}`
        }
    });

    if (!res.ok) {
        console.error("Shelf not accessible or does not exist");
        return;
    }

    goto(`/shelves/${shelfId}`);
  }
</script>

<h2>Device Connected Successfully</h2>
<button on:click={finish}>Go to Shelf</button>