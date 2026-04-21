<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<h1>Supabase health check</h1>

{#if data.ok}
  <p style="color: green">
    Connection OK — queried <code>shelves</code> in {data.elapsedMs}ms, {data.count}
    row(s) visible to the anon key.
  </p>
{:else}
  <p style="color: crimson">Connection failed after {data.elapsedMs}ms.</p>
  <pre>{JSON.stringify(data.error, null, 2)}</pre>
{/if}
