<script lang="ts">
  import type { SetupErrorAction } from "../setup/errorActions";
  import { handleSetupError } from "../setup/errorHandler";

  export let message: string = "";
  export let action: SetupErrorAction | null = null;
</script>

{#if message}
  <div class="error-banner">
    <p>{message}</p>

    {#if action}
      <button on:click={() => handleSetupError(action)}>
        Try again
      </button>
    {/if}
  </div>
{/if}

<!-- Feel free to change styling -->
<style>
  .error-banner {
    background: #fee;
    color: #900;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    border: 1px solid #f99;
  }
</style>