<script lang="ts">
  import { setupState } from "../setup/stores";

  export let message: string = "";
</script>

{#if message}
  <div class="error-banner">
    <p>{message}</p>

    <button on:click={() => setupState.update(s => ({...s, error: undefined}))}>
        Dismiss
    </button>

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