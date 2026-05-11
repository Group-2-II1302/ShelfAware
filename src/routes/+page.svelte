<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { invalidate, goto, replaceState } from '$app/navigation'
  import { page } from '$app/state'
  import type { PageData } from './$types'
  import SyncStatusBadge from '$lib/components/SyncStatusBadge.svelte'
  import Sparkline from '$lib/components/Sparkline.svelte'
  import {
    formatDelta,
    formatExpiredAgo,
    formatGrams,
    formatGramsPerDay,
  } from '$lib/format'
  import {
    IconMoodSmileBeam,
    IconPlus,
    IconTrendingDown,
    IconAlertTriangle,
    IconTrash,
  } from '@tabler/icons-svelte'

  let { data }: { data: PageData } = $props()

  /*
    Tab state, persisted in the URL via ?tab=insights so refresh and
    bookmarks survive. "today" is the default and elides the query
    param entirely (no ?tab=today noise in the address bar).
  */
  const TAB_STORAGE_KEY = 'shelfaware.dashboard.tab'
  type Tab = 'today' | 'insights'

  function resolveInitialTab(): Tab {
    /*
      Resolution priority:
        1. ?tab=... in the URL (explicit user intent, deep-link from
           elsewhere in the app, or a back/refresh on the same view)
        2. localStorage (last-used tab on this device)
        3. 'today' default
      SSR has no localStorage, so we treat the initial tab as 'today'
      there to avoid layout flashes; the effect below upgrades it
      once the client has hydrated.
    */
    const param = page.url.searchParams.get('tab')
    if (param === 'insights' || param === 'today') return param
    return 'today'
  }

  let activeTab = $state<Tab>(resolveInitialTab())

  onMount(() => {
    /*
      Apply localStorage fallback after hydration. Only kicks in when
      the URL didn't carry an explicit ?tab — otherwise the URL wins.
    */
    if (page.url.searchParams.has('tab')) return
    try {
      const stored = localStorage.getItem(TAB_STORAGE_KEY)
      if (stored === 'insights' || stored === 'today') {
        if (stored !== activeTab) activeTab = stored
      }
    } catch {
      /* localStorage can throw in privacy modes; fall back silently. */
    }
  })

  function setTab(next: Tab) {
    if (next === activeTab) return
    activeTab = next
    const url = new URL(page.url)
    if (next === 'today') {
      url.searchParams.delete('tab')
    } else {
      url.searchParams.set('tab', next)
    }
    replaceState(url.toString(), page.state)
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  /*
    Switch the insights time range. We use goto() with replaceState
    + keepFocus so the URL updates, the server load re-runs against
    the new ?range value, but we don't push a new history entry per
    click (the user shouldn't have to mash Back to undo a toggle).
  */
  function setRange(next: string) {
    if (next === data.insights.range) return
    const url = new URL(page.url)
    if (next === '30d') {
      url.searchParams.delete('range')
    } else {
      url.searchParams.set('range', next)
    }
    void goto(url.toString(), {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    })
  }

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

  <div class="tabs" role="tablist" aria-label="Dashboard sections">
    <button
      type="button"
      role="tab"
      class="tabs__btn"
      class:tabs__btn--active={activeTab === 'today'}
      aria-selected={activeTab === 'today'}
      aria-controls="panel-today"
      id="tab-today"
      onclick={() => setTab('today')}
    >
      Today
    </button>
    <button
      type="button"
      role="tab"
      class="tabs__btn"
      class:tabs__btn--active={activeTab === 'insights'}
      aria-selected={activeTab === 'insights'}
      aria-controls="panel-insights"
      id="tab-insights"
      onclick={() => setTab('insights')}
    >
      Insights
    </button>
  </div>

  {#if activeTab === 'today'}
  <div role="tabpanel" id="panel-today" aria-labelledby="tab-today">

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

    <ul
      class="folder-grid"
      class:folder-grid--empty={data.shelves.length === 0}
    >
      {#each data.shelves as shelf (shelf.id)}
        <li class="folder">
          <a
            href="/shelves/{shelf.id}"
            class="folder__link"
            aria-label="{shelf.name}, {shelf.filledSlots} of {shelf.totalSlots} slots filled"
          >
            <div
              class="folder__preview"
              role="img"
              aria-hidden="true"
            >
              {#each shelf.slotStates as state, i (i)}
                <span class="folder__cell folder__cell--{state}"></span>
              {/each}
            </div>

            <div class="folder__caption">
              <span class="folder__name">{shelf.name}</span>
              <span class="folder__meta">
                <span class="folder__count">
                  {shelf.filledSlots}/{shelf.totalSlots}
                </span>
                <SyncStatusBadge
                  lastSeen={liveSyncBy[shelf.id]}
                  hasItems={shelf.hasItems}
                  dotOnly
                />
              </span>
            </div>
          </a>
        </li>
      {/each}

      <li
        class="folder folder--add"
        class:folder--add-hero={data.shelves.length === 0}
      >
        <a href="/setup" class="folder__link folder__link--add">
          <span class="folder__add-icon" aria-hidden="true">
            <IconPlus size={28} stroke={1.75} />
          </span>
          <span class="folder__name folder__name--add">
            {data.shelves.length === 0
              ? 'Pair your first shelf'
              : 'Pair a new shelf'}
          </span>
        </a>
      </li>
    </ul>
  </section>

  </div>
  {:else}
  {@const ins = data.insights}
  {@const sparse = ins.daysOfHistory < ins.minDataDays}
  <div role="tabpanel" id="panel-insights" aria-labelledby="tab-insights" class="insights">
    <div class="range-toggle" role="group" aria-label="Time range">
      {#each ins.availableRanges as r (r)}
        <button
          type="button"
          class="range-toggle__btn"
          class:range-toggle__btn--active={ins.range === r}
          aria-pressed={ins.range === r}
          onclick={() => setRange(r)}
        >
          {r}
        </button>
      {/each}
    </div>

    {#if sparse}
      <div class="insights__sparse">
        <p class="insights__sparse-title">Insights are warming up</p>
        <p class="insights__sparse-body">
          Come back in a few days — once your shelves have built up a bit of
          weight history, this is where you'll see what you eat through
          fastest, what's always running low, and what's been wasted.
        </p>
      </div>
    {:else}
      <section class="overview" aria-label="Period summary">
        <div class="overview__metric">
          <span class="overview__value">{formatGrams(ins.overview.consumedTotalG)}</span>
          <span class="overview__label">consumed</span>
          {#if ins.overview.delta.consumedPct !== null}
            <span
              class="overview__delta"
              class:overview__delta--up={ins.overview.delta.consumedPct > 0}
              class:overview__delta--down={ins.overview.delta.consumedPct < 0}
              title="vs previous {ins.windowDays} days"
            >
              {formatDelta(ins.overview.delta.consumedPct)}
            </span>
          {/if}
        </div>

        <div class="overview__metric">
          <span class="overview__value">{ins.overview.wastedItemCount}</span>
          <span class="overview__label">
            {ins.overview.wastedItemCount === 1 ? 'item wasted' : 'items wasted'}
          </span>
          {#if ins.overview.delta.wastedPct !== null}
            <span
              class="overview__delta"
              class:overview__delta--good={ins.overview.delta.wastedPct < 0}
              class:overview__delta--bad={ins.overview.delta.wastedPct > 0}
              title="vs previous {ins.windowDays} days"
            >
              {formatDelta(ins.overview.delta.wastedPct)}
            </span>
          {/if}
        </div>

        <div class="overview__metric">
          <span class="overview__value">{ins.overview.lowStockAlertCount}</span>
          <span class="overview__label">low-stock alerts</span>
          {#if ins.overview.delta.lowStockPct !== null}
            <span
              class="overview__delta"
              class:overview__delta--good={ins.overview.delta.lowStockPct < 0}
              class:overview__delta--bad={ins.overview.delta.lowStockPct > 0}
              title="vs previous {ins.windowDays} days"
            >
              {formatDelta(ins.overview.delta.lowStockPct)}
            </span>
          {/if}
        </div>
      </section>
    {/if}

    <!-- Wasted summary card -->
    <section class="insight-card" aria-labelledby="wasted-heading">
      <header class="insight-card__head">
        <span class="insight-card__icon insight-card__icon--alert" aria-hidden="true">
          <IconTrash size={20} stroke={1.75} />
        </span>
        <div>
          <h2 id="wasted-heading" class="insight-card__title">Wasted</h2>
          <p class="insight-card__subtitle">last {ins.windowDays} days</p>
        </div>
      </header>

      {#if sparse}
        <div class="skeleton skeleton--summary"></div>
      {:else if ins.wastedItemCount === 0}
        <p class="insight-card__empty">
          Nothing wasted in the last {ins.windowDays} days. Nice work.
        </p>
      {:else}
        <p class="wasted-summary">
          <span class="wasted-summary__count">{ins.wastedItemCount}</span>
          {ins.wastedItemCount === 1 ? 'item' : 'items'} expired with weight
          still on the scale &ndash;
          {#if ins.wastedWeightApproximate}
            about <strong>{formatGrams(ins.wastedTotalG)}</strong> on-scale
            (includes container)
          {:else}
            roughly <strong>{formatGrams(ins.wastedTotalG)}</strong> of product
          {/if}
        </p>
        <ul class="insight-list">
          {#each ins.wasted as item (item.itemId)}
            <li>
              <a
                class="insight-row"
                href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
              >
                {#if item.imageUrl}
                  <img
                    class="insight-row__img"
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                {:else}
                  <span class="insight-row__img insight-row__img--placeholder" aria-hidden="true">
                    {item.name.charAt(0).toUpperCase()}
                  </span>
                {/if}
                <div class="insight-row__body">
                  <p class="insight-row__name">{item.name}</p>
                  <p class="insight-row__meta">
                    expired {formatExpiredAgo(item.expiryDate)} ·
                    {#if item.weightIsApproximate}
                      {formatGrams(item.estimatedRemainingG)} on scale
                    {:else}
                      ~{formatGrams(item.estimatedRemainingG)} left
                    {/if}
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Fastest consumed -->
    <section class="insight-card" aria-labelledby="fastest-heading">
      <header class="insight-card__head">
        <span class="insight-card__icon insight-card__icon--matcha" aria-hidden="true">
          <IconTrendingDown size={20} stroke={1.75} />
        </span>
        <div>
          <h2 id="fastest-heading" class="insight-card__title">Eat through fastest</h2>
          <p class="insight-card__subtitle">grams per day, last {ins.windowDays} days</p>
        </div>
      </header>

      {#if sparse || ins.fastestConsumed.length === 0}
        {#if sparse}
          <div class="skeleton skeleton--row"></div>
          <div class="skeleton skeleton--row"></div>
          <div class="skeleton skeleton--row"></div>
        {:else}
          <p class="insight-card__empty">
            Not enough movement on your shelves yet to rank consumption.
          </p>
        {/if}
      {:else}
        <ul class="insight-list">
          {#each ins.fastestConsumed as item (item.itemId)}
            <li>
              <a
                class="insight-row"
                href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
              >
                {#if item.imageUrl}
                  <img
                    class="insight-row__img"
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                {:else}
                  <span class="insight-row__img insight-row__img--placeholder" aria-hidden="true">
                    {item.name.charAt(0).toUpperCase()}
                  </span>
                {/if}
                <div class="insight-row__body">
                  <p class="insight-row__name">{item.name}</p>
                  <p class="insight-row__meta">
                    {formatGramsPerDay(item.gPerDay)} · {Math.round(item.daysObserved)}d observed
                  </p>
                </div>
                <Sparkline
                  values={item.sparkline}
                  width={84}
                  height={28}
                  strokeWidth={1.5}
                />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Always running low -->
    <section class="insight-card" aria-labelledby="low-heading">
      <header class="insight-card__head">
        <span class="insight-card__icon insight-card__icon--warn" aria-hidden="true">
          <IconAlertTriangle size={20} stroke={1.75} />
        </span>
        <div>
          <h2 id="low-heading" class="insight-card__title">Always running low</h2>
          <p class="insight-card__subtitle">
            triggered low-stock most often, last {ins.windowDays} days
          </p>
        </div>
      </header>

      {#if sparse || ins.alwaysRunningLow.length === 0}
        {#if sparse}
          <div class="skeleton skeleton--row"></div>
          <div class="skeleton skeleton--row"></div>
        {:else}
          <p class="insight-card__empty">
            Nothing has tripped a low-stock alert in this window.
          </p>
        {/if}
      {:else}
        <ul class="insight-list">
          {#each ins.alwaysRunningLow as item (item.itemId)}
            <li>
              <a
                class="insight-row"
                href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
              >
                {#if item.imageUrl}
                  <img
                    class="insight-row__img"
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                {:else}
                  <span class="insight-row__img insight-row__img--placeholder" aria-hidden="true">
                    {item.name.charAt(0).toUpperCase()}
                  </span>
                {/if}
                <div class="insight-row__body">
                  <p class="insight-row__name">{item.name}</p>
                  <p class="insight-row__meta">
                    {item.alertCount} {item.alertCount === 1 ? 'alert' : 'alerts'}
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
  {/if}
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

  /* ── Tabs ───────────────────────────────────────────────────────────── */

  .tabs {
    display: flex;
    gap: 0.25rem;
    margin: 0 -0.25rem 1.5rem;
    border-bottom: 1px solid var(--border);
    position: relative;
  }

  .tabs__btn {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    padding: 0.65rem 0.5rem 0.7rem;
    cursor: pointer;
    opacity: 0.55;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: opacity 0.15s ease, border-color 0.2s ease;
  }

  .tabs__btn:hover,
  .tabs__btn:focus-visible {
    opacity: 0.85;
  }

  .tabs__btn--active {
    opacity: 1;
    font-weight: 600;
    border-bottom-color: var(--text);
    color: var(--text);
  }

  /* ── Insights tab ──────────────────────────────────────────────────── */

  .insights {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ── Range toggle ────────────────────────────────────────────────── */

  .range-toggle {
    display: inline-flex;
    align-self: flex-end;
    padding: 3px;
    border-radius: var(--radius-pill);
    background: var(--background);
    border: 1px solid var(--border);
    gap: 0;
  }

  .range-toggle__btn {
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 500;
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-pill);
    cursor: pointer;
    opacity: 0.6;
    transition: background-color 0.15s ease, opacity 0.15s ease, color 0.15s ease;
  }

  .range-toggle__btn:hover {
    opacity: 0.9;
  }

  .range-toggle__btn--active {
    background: var(--surface);
    color: var(--matcha-deep);
    opacity: 1;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }

  /* ── Overview row ────────────────────────────────────────────────── */

  .overview {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 0.85rem 1rem;
  }

  .overview__metric {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }

  .overview__value {
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .overview__label {
    font-size: 0.72rem;
    opacity: 0.65;
    line-height: 1.2;
    margin-top: 0.15rem;
  }

  .overview__delta {
    font-size: 0.7rem;
    font-weight: 600;
    margin-top: 0.25rem;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--background);
    opacity: 0.7;
  }

  /*
    Two color schemes:
      - up/down (neutral): consumed went up vs prev (more or less is
        neither good nor bad — just informative)
      - good/bad (judged): wasted/low-stock down = good, up = bad
  */
  .overview__delta--down {
    color: var(--matcha-deep);
  }
  .overview__delta--up {
    color: var(--text);
  }
  .overview__delta--good {
    color: var(--matcha-deep);
    background: var(--matcha-soft);
    opacity: 1;
  }
  .overview__delta--bad {
    color: var(--error, #c0392b);
    background: rgba(192, 57, 43, 0.1);
    opacity: 1;
  }

  .insights__sparse {
    background: var(--matcha-soft);
    border: 1px solid var(--matcha);
    border-radius: var(--radius-lg);
    padding: 1rem 1.1rem;
  }

  .insights__sparse-title {
    margin: 0 0 0.35rem;
    font-weight: 600;
    color: var(--matcha-deep);
  }

  .insights__sparse-body {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.45;
    opacity: 0.85;
  }

  .insight-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem 1.1rem;
  }

  .insight-card__head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin-bottom: 0.85rem;
  }

  .insight-card__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.2rem;
    height: 2.2rem;
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }

  .insight-card__icon--matcha {
    background: var(--matcha-soft);
    color: var(--matcha-deep);
  }

  .insight-card__icon--warn {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .insight-card__icon--alert {
    background: rgba(192, 57, 43, 0.1);
    color: var(--error, #c0392b);
  }

  .insight-card__title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
    line-height: 1.2;
  }

  .insight-card__subtitle {
    margin: 0.15rem 0 0;
    font-size: 0.78rem;
    opacity: 0.65;
  }

  .insight-card__empty {
    margin: 0;
    font-size: 0.9rem;
    opacity: 0.7;
  }

  .wasted-summary {
    margin-bottom: 0.85rem;
    font-size: 0.9rem;
    line-height: 1.45;
    opacity: 0.85;
  }

  .wasted-summary__count {
    font-weight: 700;
    color: var(--error, #c0392b);
    font-variant-numeric: tabular-nums;
  }

  .wasted-summary__label {
    /* No special treatment — it now flows inline with the count. */
  }

  .insight-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .insight-row {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
    color: inherit;
    text-decoration: none;
    padding: 0.35rem 0.4rem;
    margin: -0.35rem -0.4rem;
    border-radius: var(--radius-md);
    transition: background-color 0.15s ease;
  }

  .insight-row:hover,
  .insight-row:focus-visible {
    background: var(--background);
  }

  .insight-row__img {
    width: 2.4rem;
    height: 2.4rem;
    border-radius: var(--radius-md);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--background);
  }

  .insight-row__img--placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    color: var(--matcha-deep);
  }

  .insight-row__body {
    flex: 1;
    min-width: 0;
  }

  .insight-row__name {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 500;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .insight-row__meta {
    margin: 0.1rem 0 0;
    font-size: 0.78rem;
    opacity: 0.7;
  }

  /* ── Skeleton placeholders ─────────────────────────────────────────── */

  .skeleton {
    border-radius: var(--radius-md);
    background: linear-gradient(
      90deg,
      var(--background) 0%,
      rgba(0, 0, 0, 0.04) 50%,
      var(--background) 100%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.6s linear infinite;
  }

  .skeleton--summary {
    height: 3rem;
    margin-bottom: 0.85rem;
  }

  .skeleton--row {
    height: 2.4rem;
    margin-bottom: 0.6rem;
  }

  .skeleton--row:last-child {
    margin-bottom: 0;
  }

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
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

  /* ── Folder-style shelf grid ────────────────────────────────────────── */

  .folder-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: 0.85rem;
  }

  .folder {
    margin: 0;
    /*
      Grid items default to min-width: min-content, which for a long
      unbroken shelf name (e.g. "MyVeryLongFridgeName") forces the
      track wider than the configured 8.5rem minimum and breaks the
      tile's square aspect ratio. Pin to 0 so the caption can clamp.
    */
    min-width: 0;
  }

  .folder__link {
    display: flex;
    flex-direction: column;
    height: 100%;
    aspect-ratio: 1 / 1;
    padding: 0.75rem;
    box-sizing: border-box;
    min-width: 0;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: inherit;
    text-decoration: none;
    transition:
      background-color 0.15s ease,
      transform 0.12s ease,
      box-shadow 0.15s ease;
  }

  .folder__link:hover,
  .folder__link:focus-visible {
    background: var(--background);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(51, 42, 38, 0.06);
  }

  /*
    iOS-folder preview: a 3×2 grid of micro-cells, one per slot.
    Filled cells use the matcha accent; empty cells render as a faint
    dashed outline so the user can still see "this slot exists, it's
    just empty" without competing visually with filled ones.
  */
  .folder__preview {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(2, 1fr);
    gap: 0.3rem;
    padding: 0.35rem;
    background: var(--background);
    border-radius: var(--radius-md);
    margin-bottom: 0.55rem;
  }

  .folder__cell {
    border-radius: var(--radius-xs);
    border: 1px dashed rgba(51, 42, 38, 0.18);
    background: transparent;
    transition: background-color 0.3s ease, border-color 0.3s ease;
  }

  /*
    Filled cells are color-coded by urgency so the preview itself
    becomes the status indicator — no separate text line needed.
    Severity order: expired > urgent (expires ≤2d) > low (stock) > normal.
  */
  .folder__cell--normal {
    background: var(--matcha);
    border-color: var(--matcha-deep);
    border-style: solid;
  }

  .folder__cell--low {
    background: var(--warn);
    border-color: var(--warn);
    border-style: solid;
  }

  .folder__cell--urgent {
    background: var(--warn);
    border-color: var(--warn);
    border-style: solid;
  }

  .folder__cell--expired {
    background: var(--error, #c0392b);
    border-color: var(--error, #c0392b);
    border-style: solid;
  }

  .folder__caption {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .folder__name {
    font-weight: 600;
    font-size: 0.9rem;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    max-width: 100%;
  }

  .folder__meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.74rem;
    color: var(--text);
    opacity: 0.7;
    min-width: 0;
  }

  .folder__count {
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* Status dot at the far right of the meta line. */
  .folder__meta :global(.sync-badge--dot-only) {
    margin-left: auto;
    flex-shrink: 0;
  }

  /* ── Add-shelf tile ─────────────────────────────────────────────────── */

  .folder__link--add {
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    background: transparent;
    border-style: dashed;
    color: var(--text);
    text-align: center;
  }

  .folder__link--add:hover,
  .folder__link--add:focus-visible {
    background: var(--warn-soft);
  }

  .folder--add-hero .folder__link--add {
    grid-column: 1 / -1;
    background: var(--warn-soft);
    border-style: solid;
    border-color: var(--warn);
  }

  .folder--add-hero {
    grid-column: 1 / -1;
  }

  .folder__add-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.4rem;
    height: 2.4rem;
    border-radius: var(--radius-pill);
    background: var(--text);
    color: var(--background);
    flex-shrink: 0;
  }

  /*
    Defensively force the stroke color on the icon SVG itself so it
    doesn't get pulled toward the link's text color via inheritance
    edge cases (e.g. inherit vs initial on certain Svelte renderers).
  */
  .folder__add-icon :global(svg) {
    color: var(--background);
    stroke: var(--background);
  }

  .folder__name--add {
    white-space: normal;
    font-weight: 500;
    font-size: 0.88rem;
  }
</style>
