<script lang="ts">
  import { setupState } from "../../lib/stores";
  import WifiStep from "./wifi-step.svelte";
  import ProvisionStep from "./provision-step.svelte";
  import ConnectingStep from "./connecting-step.svelte";
  import SuccessStep from "./success-step.svelte";

  $: step = $setupState.step;
</script>

{#if step === "wifi"}
  <WifiStep />
{:else if step === "provision"}
  <ProvisionStep />
{:else if step === "connecting"}
  <ConnectingStep />
{:else if step === "success"}
  <SuccessStep />
{/if}