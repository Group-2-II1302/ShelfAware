<script lang="ts">
  import { setupState } from "../../lib/setup/stores";
  import ErrorBanner from "../../lib/components/ErrorBanner.svelte";
  import { waitForNewShelf } from "../../lib/setup/waitForShelf"
  import { onMount } from "svelte";

  let cancelled = false;

  async function startWaiting() {
    setupState.set({
        step: "waiting",
        shelfId: undefined,
        error: undefined
    });

    try {
        const shelfId = await waitForNewShelf();

        if (cancelled) return;

        setupState.set({
            step: "success",
            shelfId,
            error: undefined
        });
    } catch (e) {
        if (cancelled) return;

        setupState.set({
            step: "error",
            shelfId: undefined,
            error: "Device setup timed out. Please try again."
        });
    }
  }

  onMount (() => {
    startWaiting();

    return () => {
        cancelled = true;
    };
  });
</script>

<h2>Waiting for device setup</h2>
<p>
  Complete setup in the device window (Pi hotspot page).<br />
  We will automatically detect when it's ready.
</p>

{#if $setupState.error}
    <ErrorBanner message={$setupState.error} />
{/if}