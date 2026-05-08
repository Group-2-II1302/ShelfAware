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
    Safety-net invalidate. Optimistic patches below cover the common
    case (Pi inserts a weight_logs row → bump the matching shelf's
    lastSyncedAt). This catches everything else — items added or
    removed by another client, new shelves appearing, etc. — without
    us subscribing to every related table.
  */
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleRefresh() {
    if (invalidateTimer) return
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined
      invalidate('app:shelves')
    }, 30_000)
  }

  let channel: ReturnType<typeof data.supabase.channel> | undefined

  onMount(() => {
    channel = data.supabase
      .channel('dashboard-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'weight_logs' },
        (payload) => {
          const row = payload.new as { item_id?: string; recorded_at?: string }
          /*
            Map item_id back to the shelf via the index we built at
            load time. If we don't recognise the item, it's probably
            a brand new shelf added by another client — fall back to
            a refresh so the row appears.
          */
          const shelfId = row?.item_id ? data.itemShelfMap[row.item_id] : undefined
          if (!shelfId) {
            scheduleRefresh()
            return
          }
          if (
            row.recorded_at &&
            (!liveSyncBy[shelfId] || row.recorded_at > liveSyncBy[shelfId]!)
          ) {
            liveSyncBy = { ...liveSyncBy, [shelfId]: row.recorded_at }
          }
        },
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
