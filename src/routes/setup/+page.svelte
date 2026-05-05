<script lang="ts">
  import { setupState } from "../../lib/setup/stores";
  import ConnectingStep from "./connecting-step.svelte";
  import SuccessStep from "./success-step.svelte";

  $: step = $setupState.step;
</script>

{#if step === "connecting"}
  <ConnectingStep />
{:else if step === "success"}
  <SuccessStep />
{/if}