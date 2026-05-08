<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { invalidate } from '$app/navigation'
  import type { PageData } from './$types'
  import SyncStatusBadge from '$lib/components/SyncStatusBadge.svelte'

  let { data }: { data: PageData } = $props()

  /*
    Local mirror of the per-shelf lastSyncedAt so we can update it in
    response to realtime weight_logs inserts without re-running the
    server load. Keyed by shelf id; falls back to the value from
    server load on first render.
  */
  let liveSyncBy = $state<Record<string, string | null>>(
    Object.fromEntries(data.shelves.map((s) => [s.id, s.lastSyncedAt])),
  )

  /*
    When the server load runs again (e.g. via invalidate) we want the
    local map to pick up its values. Reactive guard avoids clobbering
    a more-recent realtime value with a stale server one.
  */
  $effect(() => {
    for (const shelf of data.shelves) {
      const local = liveSyncBy[shelf.id]
      const fromServer = shelf.lastSyncedAt
      if (!local || (fromServer && fromServer > local)) {
        liveSyncBy[shelf.id] = fromServer
      }
    }
  })

  /*
    To map an incoming weight_logs row (which only has item_id) back
    to the shelf it belongs to, we'd normally need a second query.
    Cheaper path: look at all item_ids the server load already knew
    about per shelf. The server load doesn't expose those today;
    rather than adding a second round-trip, we listen broadly to
    weight_logs and trigger a SvelteKit invalidation that re-runs
    the load. Throttled below so a chatty Pi doesn't hammer us.
  */
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleRefresh() {
    if (invalidateTimer) return
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined
      invalidate('app:shelves')
    }, 4_000)
  }

  let channel: ReturnType<typeof data.supabase.channel> | undefined

  onMount(() => {
    channel = data.supabase
      .channel('dashboard-weight-logs')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'weight_logs' },
        () => scheduleRefresh(),
      )
      .subscribe()
  })

  onDestroy(() => {
    if (invalidateTimer) clearTimeout(invalidateTimer)
    if (channel) channel.unsubscribe()
  })
</script>

<svelte:head>
  <title>your shelves · shelfAware</title>
</svelte:head>

<main class="dashboard">
  <header class="dashboard__header">
    <h1>welcome to shelfAware</h1>
    <p class="dashboard__subtitle">your shelves</p>
  </header>

  <ul class="shelf-list">
    {#each data.shelves as shelf (shelf.id)}
      <li class="shelf-list__item">
        <a href="/shelves/{shelf.id}" class="shelf-list__link">
          <span class="shelf-list__name">{shelf.name}</span>
          <SyncStatusBadge
            lastSeen={liveSyncBy[shelf.id]}
            hasItems={shelf.hasItems}
            compact
          />
        </a>
      </li>
    {/each}
  </ul>
</main>

<style>
  .dashboard {
    width: 100%;
    padding: 1rem;
    box-sizing: border-box;
    max-width: 32rem;
    margin: 0 auto;
  }

  .dashboard__header {
    margin-bottom: 1rem;
  }

  .dashboard__header h1 {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.2;
  }

  .dashboard__subtitle {
    margin: 0.25rem 0 0;
    opacity: 0.7;
    font-size: 0.9rem;
  }

  .shelf-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .shelf-list__item {
    margin: 0;
  }

  .shelf-list__link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
    border-radius: 0.75rem;
    background: var(--surface, rgba(0, 0, 0, 0.04));
    color: inherit;
    text-decoration: none;
    transition:
      background-color 0.15s ease,
      transform 0.12s ease;
  }

  .shelf-list__link:hover,
  .shelf-list__link:focus-visible {
    background: var(--surface-hover, rgba(0, 0, 0, 0.07));
    transform: translateY(-1px);
  }

  .shelf-list__name {
    font-weight: 500;
    overflow-wrap: anywhere;
    min-width: 0;
  }
</style>
