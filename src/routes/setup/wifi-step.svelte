<script lang="ts">
  import { setupState } from "../../lib/setup/stores";
  import { checkHealth } from "../../lib/pi";
  import ErrorBanner from "../../lib/components/ErrorBanner.svelte";

  let error = "";

  async function continueSetup() {
    setupState.update(s => ({
        ...s,
        loading: true,
        error: undefined
    }));

    try {
        const health = await checkHealth();

        if (health.already_provisioned) {
            setupState.update(s => ({
                ...s,
                error: "Device is already set up. Please reset it first."
            }));
            return;
        }

        setupState.update(s => ({
            ...s,
            deviceId: health.device,
            step: "provision",
            loading: false
        }));
    } catch (e) {
        setupState.update(s => ({
            ...s,
            loading: false,
            error: "Could not connect to device. Make sure you're on the setup WiFi."
        }));
    }
  }
</script>

<ErrorBanner
  message={$setupState.error}
  action={{ type: "RESET_SETUP" }}
/>

<h2>Connect to Device</h2>
<p>Join WiFi: <b>ShelfAware_Setup</b></p>

<button on:click={continueSetup} disabled={$setupState.loading}>
  {$setupState.loading ? "Checking..." : "Continue"}
</button>

{#if error}<p>{error}</p>{/if}