<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { invalidate } from '$app/navigation'
  import type { PageData } from './$types'
  import SyncStatusBadge from '$lib/components/SyncStatusBadge.svelte'
  import { IconMoodSmileBeam, IconPlus } from '@tabler/icons-svelte'

  let { data }: { data: PageData } = $props()

  /*
    Local mirror of the per-shelf lastSyncedAt so we can update it in
    response to realtime weight_logs inserts without re-running the
    server load. Keyed by shelf id; falls back to the value from
    server load on first render.
  */
  let liveSyncBy = $state<Record<string, string | null>>({});

  /*
    When the server load runs again (e.g. via invalidate) we want the
    local map to pick up its values. Reactive guard avoids clobbering
    a more-recent realtime value with a stale server one.
  */
  $effect(() => {
    for (const shelf of data.shelves) {
      if (!(shelf.id in liveSyncBy)) {
        liveSyncBy[shelf.id] = shelf.lastSyncedAt;
        continue;
      }

      const local = liveSyncBy[shelf.id];

      if (
        !local ||
        (shelf.lastSyncedAt && shelf.lastSyncedAt > local)
      ) {
        liveSyncBy[shelf.id] = shelf.lastSyncedAt;
      }
    }
  });

  /*
    Safety-net invalidate. Optimistic patches below cover the common
    case (Pi inserts a weight_logs row → bump the matching shelf's
    lastSyncedAt). This catches everything else — items added or
    removed by another client, new shelves appearing, etc. — without
    us subscribing to every related table.
  */
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined
  let scheduledDelay = Number.POSITIVE_INFINITY

  /*
    Debounced invalidate. shelf_items changes (weight crossing the
    low-stock threshold, expiry edits, inserts/deletes) need to be
    reflected in the "Now" lists quickly, so they pass a small delay.
    weight_logs inserts only matter for the sync badge — patched
    optimistically — so they use a longer safety-net delay.
  */
  function scheduleRefresh(delay: number = 30_000) {
    if (invalidateTimer && delay >= scheduledDelay) return
    if (invalidateTimer) clearTimeout(invalidateTimer)
    scheduledDelay = delay
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined
      scheduledDelay = Number.POSITIVE_INFINITY
      invalidate('app:shelves')
    }, delay)
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
      /*
        Any change to shelf_items can affect the "Now" lists (weight
        crossed the low-stock threshold, expiry edited, item replaced,
        new item added, item removed). Cheaper and more correct to
        refresh the server load than to mirror the full bucket logic
        client-side — but debounced so a flurry of weight updates from
        the Pi doesn't thrash the network.
      */
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shelf_items' },
        () => scheduleRefresh(2_500),
      )
      .subscribe()
  })

  onDestroy(() => {
    if (invalidateTimer) clearTimeout(invalidateTimer)
    if (channel) channel.unsubscribe()
  })

  function greeting(): string {
    const hour = new Date().getHours()
    if (hour < 5) return 'still up'
    if (hour < 12) return 'good morning'
    if (hour < 17) return 'good afternoon'
    if (hour < 22) return 'good evening'
    return 'good night'
  }

  function subtitle(): string {
    /*
      Pick a subtitle that adapts to the user's situation. Keeps the
      tone warm without being twee. Reads what's actually on the page
      via data.actions so it never lies.
    */
    if (data.actions.expiringTotal === 0 && data.actions.lowStockTotal === 0) {
      return data.shelves.length === 0
        ? "let's get your first shelf paired"
        : "your kitchen is looking tidy today"
    }
    if (data.actions.expiringTotal > 0 && data.actions.lowStockTotal > 0) {
      return "a couple of things need your attention"
    }
    if (data.actions.expiringTotal > 0) {
      return data.actions.expiringTotal === 1
        ? 'one item needs eating soon'
        : 'a few items need eating soon'
    }
    return data.actions.lowStockTotal === 1
      ? 'one item is running low'
      : 'some items are running low'
  }

  function formatExpiry(days: number | null): string {
    if (days === null) return ''
    if (days < 0) {
      const ago = Math.abs(days)
      return ago === 1 ? 'expired yesterday' : `expired ${ago} days ago`
    }
    if (days === 0) return 'expires today'
    if (days === 1) return 'expires tomorrow'
    return `in ${days} days`
  }

  function formatLowStock(item: {
    currentWeightG: number | null
    thresholdG: number | null
  }): string {
    if (item.currentWeightG === null) return 'low'
    if (item.currentWeightG <= 0) return 'empty'
    if (item.thresholdG && item.thresholdG > 0) {
      const pct = Math.max(
        0,
        Math.min(100, Math.round((item.currentWeightG / item.thresholdG) * 100)),
      )
      return `${pct}% of threshold`
    }
    return `${Math.round(item.currentWeightG)} g`
  }
</script>

<svelte:head>
  <title>your shelves · shelfAware</title>
</svelte:head>

<main class="dashboard">
  <header class="dashboard__header">
    <h1>
      {greeting()}{data.firstName ? `, ${data.firstName}` : ''}<span
        class="greet-mark"
        aria-hidden="true">&nbsp;<IconMoodSmileBeam
          size={26}
          stroke={1.75}
        /></span>
    </h1>
    <p class="dashboard__subtitle">
      welcome back to <span class="brand">ShelfAware</span> - {subtitle()}
    </p>
  </header>

  <section class="now" aria-labelledby="now-heading">
    <h2 id="now-heading" class="section-title">Now</h2>

    {#if data.actions.expiringTotal === 0 && data.actions.lowStockTotal === 0}
      <div class="now__empty">
        <span class="now__empty-mark" aria-hidden="true">✓</span>
        <p>You're all set. Nothing expiring or running low.</p>
      </div>
    {:else}
      <div class="stat-grid">
        <article
          class="stat-card stat-card--expiring"
          class:stat-card--muted={data.actions.expiringTotal === 0}
        >
          <header class="stat-card__head" aria-live="polite" aria-atomic="true">
            <span class="stat-card__count">{data.actions.expiringTotal}</span>
            <span class="stat-card__label">
              {data.actions.expiringTotal === 1 ? 'item expiring' : 'items expiring'}
            </span>
          </header>
          {#if data.actions.expiringTotal > 0}
            <p class="stat-card__breakdown">
              {#if data.actions.expiringBuckets.expired > 0}
                <span class="chip chip--alert">{data.actions.expiringBuckets.expired} expired</span>
              {/if}
              {#if data.actions.expiringBuckets.today > 0}
                <span class="chip chip--warn">{data.actions.expiringBuckets.today} today</span>
              {/if}
              {#if data.actions.expiringBuckets.soon > 0}
                <span class="chip">{data.actions.expiringBuckets.soon} this week</span>
              {/if}
            </p>

            <ul class="stat-card__list">
              {#each data.actions.expiring as item (item.id)}
                <li>
                  <a
                    class="stat-row"
                    href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
                  >
                    <span class="stat-row__name">{item.name}</span>
                    <span
                      class="stat-row__meta"
                      class:stat-row__meta--critical={(item.daysToExpiry ?? 0) < 0}
                      class:stat-row__meta--warn={item.daysToExpiry === 0 ||
                        item.daysToExpiry === 1}
                    >
                      {formatExpiry(item.daysToExpiry)}
                    </span>
                  </a>
                </li>
              {/each}
              {#if data.actions.expiringTotal > data.actions.limit}
                <li class="stat-card__more">
                  + {data.actions.expiringTotal - data.actions.limit} more
                </li>
              {/if}
            </ul>
          {/if}
        </article>

        <article class="stat-card" class:stat-card--muted={data.actions.lowStockTotal === 0}>
          <header class="stat-card__head" aria-live="polite" aria-atomic="true">
            <span class="stat-card__count">{data.actions.lowStockTotal}</span>
            <span class="stat-card__label">
              {data.actions.lowStockTotal === 1 ? 'item running low' : 'items running low'}
            </span>
          </header>
          {#if data.actions.lowStockTotal > 0}
            <p class="stat-card__breakdown">
              {#if data.actions.lowStockBuckets.empty > 0}
                <span class="chip chip--alert">{data.actions.lowStockBuckets.empty} empty</span>
              {/if}
              {#if data.actions.lowStockBuckets.low > 0}
                <span class="chip chip--warn">{data.actions.lowStockBuckets.low} low</span>
              {/if}
            </p>

            <ul class="stat-card__list">
              {#each data.actions.lowStock as item (item.id)}
                <li>
                  <a
                    class="stat-row"
                    href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
                  >
                    <span class="stat-row__name">{item.name}</span>
                    <span
                      class="stat-row__meta"
                      class:stat-row__meta--critical={item.currentWeightG !== null &&
                        item.currentWeightG <= 0}
                    >
                      {formatLowStock(item)}
                    </span>
                  </a>
                </li>
              {/each}
              {#if data.actions.lowStockTotal > data.actions.limit}
                <li class="stat-card__more">
                  + {data.actions.lowStockTotal - data.actions.limit} more
                </li>
              {/if}
            </ul>
          {/if}
        </article>
      </div>
    {/if}
  </section>

  <section class="shelves" aria-labelledby="shelves-heading">
    <h2 id="shelves-heading" class="section-title">Shelves</h2>
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
      <li class="shelf-list__item">
        <a
          href="/setup"
          class="shelf-list__link shelf-list__link--add"
          class:shelf-list__link--add-hero={data.shelves.length === 0}
        >
          <span class="shelf-list__add-icon" aria-hidden="true">
            <IconPlus size={20} stroke={1.75} />
          </span>
          <span class="shelf-list__name">
            {data.shelves.length === 0
              ? 'Pair your first shelf'
              : 'Pair a new shelf'}
          </span>
        </a>
      </li>
    </ul>
  </section>
</main>

<style>
  .dashboard {
    width: 100%;
    padding: 2rem 1rem 8rem;
    box-sizing: border-box;
    max-width: 32rem;
    margin: 0 auto;
  }

  .dashboard__header {
    margin-bottom: 1.25rem;
  }

  .dashboard__header h1 {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.2;
  }

  .brand {
    color: var(--matcha-deep);
    font-weight: 600;
  }

  .greet-mark {
    /*
      inline-block + white-space: nowrap on a span that starts with
      a &nbsp; glues the smiley to whatever word ends the heading.
      That way it follows "Christopher" onto a wrapped line instead
      of dropping to its own line on narrow phones.
    */
    display: inline-block;
    vertical-align: baseline;
    color: var(--matcha-deep);
    white-space: nowrap;
    transform-origin: 50% 50%;
    animation: greet-pulse 1.6s ease-in-out 0.3s 2;
  }

  .greet-mark :global(svg) {
    display: inline-block;
    vertical-align: middle;
    /*
      Cascadia Mono has a tall x-height; nudge the icon up so it
      sits visually centered against the lowercase letters rather
      than aligning to the descender line.
    */
    transform: translateY(-0.10em);
  }

  @media (prefers-reduced-motion: reduce) {
    .greet-mark {
      animation: none;
    }
  }

  @keyframes greet-pulse {
    0%, 100% {
      transform: scale(1) rotate(0deg);
    }
    25% {
      transform: scale(1.15) rotate(-6deg);
    }
    50% {
      transform: scale(1) rotate(6deg);
    }
    75% {
      transform: scale(1.1) rotate(-3deg);
    }
  }

  .dashboard__subtitle {
    margin: 0.25rem 0 0;
    opacity: 0.7;
    font-size: 0.9rem;
  }

  .section-title {
    margin: 0 0 0.6rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
    color: var(--matcha-deep);
  }

  .now {
    margin-bottom: 1.5rem;
  }

  .now__empty {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 1rem;
    background: var(--matcha-soft);
    border: 1px solid var(--matcha);
    border-radius: var(--radius-md);
  }

  .now__empty-mark {
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    background: var(--matcha);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  .now__empty p {
    margin: 0;
    font-size: 0.9rem;
  }

  .stat-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }

  @media (min-width: 480px) {
    .stat-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .stat-card--expiring {
    border-left-color: var(--warn);
  }

  .stat-card--muted {
    border-left-color: var(--border);
    opacity: 0.6;
  }

  .stat-card__head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .stat-card__count {
    font-size: 1.8rem;
    font-weight: 600;
    line-height: 1;
  }

  .stat-card__label {
    font-size: 0.75rem;
    opacity: 0.65;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }

  .stat-card__breakdown {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .chip {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-pill);
    background: var(--background);
    border: 1px solid var(--border);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
  }

  .chip--alert {
    border-color: var(--error);
    color: var(--error);
    background: #fff;
  }

  .chip--warn {
    border-color: var(--warn);
    color: var(--warn);
    background: var(--warn-soft);
  }

  .stat-card__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .stat-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0;
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dashed transparent;
    transition: border-color 0.15s ease;
  }

  .stat-row:hover,
  .stat-row:focus-visible {
    border-bottom-color: var(--border);
  }

  .stat-row__name {
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .stat-row__meta {
    font-size: 0.7rem;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .stat-row__meta--critical {
    opacity: 1;
    color: var(--error);
  }

  .stat-row__meta--warn {
    opacity: 1;
    color: var(--warn);
  }

  .stat-card__more {
    font-size: 0.7rem;
    opacity: 0.55;
    padding-top: 0.25rem;
  }

  .shelves {
    margin-top: 1rem;
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
    border-radius: var(--radius-md);
    background: var(--surface);
    border: 1px solid var(--border);
    color: inherit;
    text-decoration: none;
    transition:
      background-color 0.15s ease,
      transform 0.12s ease;
  }

  .shelf-list__link:hover,
  .shelf-list__link:focus-visible {
    background: var(--background);
    transform: translateY(-1px);
  }

  .shelf-list__name {
    font-weight: 500;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .shelf-list__link--add {
    background: transparent;
    border-style: dashed;
    color: var(--text);
    justify-content: flex-start;
    gap: 0.6rem;
  }

  .shelf-list__link--add:hover,
  .shelf-list__link--add:focus-visible {
    background: var(--warn-soft);
  }

  .shelf-list__link--add-hero {
    background: var(--warn-soft);
    border-style: solid;
    border-color: var(--warn);
    padding: 1.25rem 1rem;
  }

  .shelf-list__add-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: var(--radius-pill);
    background: var(--warn);
    color: #fff;
    flex-shrink: 0;
  }
</style>
