<script lang="ts">
  import { setupState } from "../../lib/stores";
  import { get } from "svelte/store";
  import { goto } from "$app/navigation";

  const { shelfId } = get(setupState);

  function finish() {
    goto(`/shelves/${shelfId}`);
  }
</script>

<h2>Device Connected Successfully</h2>
<button on:click={finish}>Go to Shelf</button>