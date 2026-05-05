<script lang="ts">
    import { setupState } from "../../lib/setup/stores";
    import ConnectingStep from "./connecting-step.svelte";
    import SuccessStep from "./success-step.svelte";
    import ErrorBanner from "../../lib/components/ErrorBanner.svelte";

  const step = $derived($setupState.step)
</script>

{#if step === "idle"}
    <div>
        <h2>Set up your device</h2>
        <p>
        1. Connect to <b>ShelfAware_Setup</b> WiFi<br />
        2. Open <b>http://192.168.4.1</b> in your browser<br />
        3. Complete setup on the device page
        </p>

        <button
        on:click={() =>
            setupState.set({
            step: "waiting",
            shelfId: null,
            error: null
            })
        }
        >
        I've completed setup
        </button>
    </div>
{:else if step === "waiting"}
  <ConnectingStep />
{:else if step === "success"}
  <SuccessStep />
{:else if step === "error"}
    <ErrorBanner
        message={$setupState.error}
    />
{/if}