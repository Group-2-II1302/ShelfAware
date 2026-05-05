<script lang="ts">
  import { setupState } from "../../lib/setup/stores";
  import { get } from "svelte/store";
  import { goto } from "$app/navigation";

  async function finish() {
    const { shelfId } = get(setupState);

    if (!shelfId) {
        console.error("Missing shelfId");
        return;
    }

    goto(`/shelves/${shelfId}`);
  }
</script>

<h2>Device Connected Successfully</h2>
<button onclick={finish}>Go to Shelf</button>