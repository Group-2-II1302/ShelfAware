<script lang="ts">
  import { setupState } from "../../lib/stores";
  import { checkHealth } from "../../lib/pi";

  let loading = false;
  let error = "";

  async function continueSetup() {
    loading = true;
    try {
      const health = await checkHealth();

      setupState.update(s => ({
        ...s,
        deviceId: health.device,
        step: "provision"
      }));
    } catch (e) {
      error = "Could not connect to device. Make sure you're on same WiFi.";
    } finally {
      loading = false;
    }
  }
</script>

<h2>Connect to Device</h2>
<p>Join WiFi: <b>ShelfAware_Setup</b></p>

<button on:click={continueSetup} disabled={loading}>
  {loading ? "Checking..." : "Continue"}
</button>

{#if error}<p>{error}</p>{/if}