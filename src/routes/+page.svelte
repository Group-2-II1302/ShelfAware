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
    IconPackage,
    IconInfoCircle,
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

  /*
    Color-legend popover for the shelves grid. Toggled by the small
    info icon next to the "Shelves" heading. Closes on outside click
    and Escape so it never gets stuck open on mobile where there's
    no hover-out.
  */
  let legendOpen = $state(false)
  let legendRoot = $state<HTMLDivElement | undefined>(undefined)

  function handleLegendDocClick(e: MouseEvent) {
    if (!legendOpen) return
    const root = legendRoot
    if (root && !root.contains(e.target as Node)) legendOpen = false
  }
  function handleLegendDocKey(e: KeyboardEvent) {
    if (legendOpen && e.key === 'Escape') legendOpen = false
  }

  /*
    Drives the soft right-edge fade on the "Now" carousels. Toggles
    `--fade-right` 0/1 based on whether there's still hidden content
    past the right edge; the stylesheet consumes it as an alpha stop
    in a `mask-image`. Left edge is intentionally never faded — the
    first tile reads as the natural "start" so a fade there would
    feel like a glitch.

    Small EDGE_TOL buffer because some browsers report
    `scrollLeft + clientWidth` slightly off from `scrollWidth` due to
    sub-pixel rounding.
  */
  function tileScrollFade(node: HTMLElement) {
    const EDGE_TOL = 2
    function updateFade() {
      const max = node.scrollWidth - node.clientWidth
      const hasOverflow = max > EDGE_TOL
      const right = hasOverflow && node.scrollLeft < max - EDGE_TOL ? 1 : 0
      node.style.setProperty('--fade-right', String(right))
    }
    updateFade()
    node.addEventListener('scroll', updateFade, { passive: true })
    const resizeObserver = new ResizeObserver(updateFade)
    resizeObserver.observe(node)

    /*
      Mouse-wheel → horizontal scroll redirect. Without this, desktop
      mouse users can't scroll the carousel at all: the scrollbar is
      hidden and a regular wheel only emits vertical deltas, which
      this container doesn't consume. Trackpad two-finger swipes
      already arrive as `deltaX` and are handled natively, so we
      only redirect when the gesture is dominantly vertical and the
      shift key isn't held (shift+wheel is a browser convention for
      horizontal scroll and shouldn't be doubled).
    */
    /*
      Mouse-wheel → horizontal scroll redirect with smooth easing.
      Without redirect, a regular mouse can't scroll the carousel
      (vertical wheel deltas don't move this overflow-x:auto box).
      `scrollBy({ behavior: 'smooth' })` animates each tick so the
      motion feels continuous instead of jumping tile-by-tile, and
      we accumulate deltas across rapid wheel events so spamming the
      wheel snowballs into a longer smooth scroll rather than
      restarting the animation each time.

      Trackpad horizontal swipes already arrive as `deltaX` and are
      handled natively; we only redirect when the gesture is
      dominantly vertical and shift isn't held.
    */
    let pendingDelta = 0
    let wheelRaf = 0
    function flushWheel() {
      wheelRaf = 0
      if (pendingDelta === 0) return
      node.scrollBy({ left: pendingDelta, behavior: 'smooth' })
      pendingDelta = 0
    }
    function onWheel(e: WheelEvent) {
      if (e.shiftKey) return
      const absX = Math.abs(e.deltaX)
      const absY = Math.abs(e.deltaY)
      if (absY <= absX) return
      const max = node.scrollWidth - node.clientWidth
      if (max <= EDGE_TOL) return
      const goingDown = e.deltaY > 0
      if (goingDown && node.scrollLeft >= max - EDGE_TOL) return
      if (!goingDown && node.scrollLeft <= EDGE_TOL) return
      e.preventDefault()
      pendingDelta += e.deltaY
      if (!wheelRaf) wheelRaf = requestAnimationFrame(flushWheel)
    }
    node.addEventListener('wheel', onWheel, { passive: false })

    return {
      update: updateFade,
      destroy() {
        resizeObserver.disconnect()
        node.removeEventListener('scroll', updateFade)
        node.removeEventListener('wheel', onWheel)
        if (wheelRaf) cancelAnimationFrame(wheelRaf)
      },
    }
  }

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
    /*
      Insights are streamed, so `data.insights` is a Promise on first
      paint — read the current range from the URL (its single source
      of truth on the server too) to short-circuit no-op clicks.
    */
    const current = page.url.searchParams.get('range') ?? '30d'
    if (next === current) return
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

    document.addEventListener('click', handleLegendDocClick)
    document.addEventListener('keydown', handleLegendDocKey)
  })

  onDestroy(() => {
    if (invalidateTimer) clearTimeout(invalidateTimer)
    if (channel) channel.unsubscribe()
    /*
      `onDestroy` also fires on the server during SSR teardown,
      where `document` doesn't exist. Guard so we don't trip a
      ReferenceError on first render.
    */
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', handleLegendDocClick)
      document.removeEventListener('keydown', handleLegendDocKey)
    }
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

  /*
    Percent of the *full container* (product + tare baseline removed).
    Falls back through a chain: tare+full → full only → null when we
    can't meaningfully compute one. Returns 0–100 clamped, or null
    when calibration is missing.
  */
  function percentFull(item: {
    currentWeightG: number | null
    tareG?: number | null
    fullG?: number | null
  }): number | null {
    if (item.currentWeightG === null) return null
    if (item.currentWeightG <= 0) return 0
    if (item.fullG && item.fullG > 0) {
      const tare = item.tareG ?? 0
      const span = item.fullG - tare
      if (span > 0) {
        const product = item.currentWeightG - tare
        const pct = (product / span) * 100
        return Math.max(0, Math.min(100, Math.round(pct)))
      }
    }
    return null
  }

  function formatLowStock(item: {
    currentWeightG: number | null
    thresholdG: number | null
    tareG?: number | null
    fullG?: number | null
  }): string {
    if (item.currentWeightG === null) return 'low'
    if (item.currentWeightG <= 0) return 'empty'
    const pct = percentFull(item)
    if (pct !== null) return `${pct}% left`
    /*
      No catalog calibration available — show absolute grams as a
      last-resort signal. "X g" is honest if not super readable; the
      slot detail view has richer context.
    */
    return `${Math.round(item.currentWeightG)} g`
  }

  /*
    Urgency bucket for the image-tile ring and badge. Mirrors the
    palette used by the folder grid's micro-cells so the two parts of
    the dashboard speak the same visual language.
      crit  → red    (expired / empty)
      warn  → amber  (≤2 days / "low" bucket)
      ok    → matcha (everything else)
  */
  function expiryUrgency(days: number | null): 'crit' | 'warn' | 'ok' {
    if (days === null) return 'ok'
    if (days < 0) return 'crit'
    if (days <= 2) return 'warn'
    return 'ok'
  }

  function lowStockUrgency(item: {
    currentWeightG: number | null
  }): 'crit' | 'warn' | 'ok' {
    if (item.currentWeightG !== null && item.currentWeightG <= 0) return 'crit'
    return 'warn'
  }

  /*
    Short badge text overlaid in the tile corner. Kept ultra-terse so
    it doesn't fight the image: "-1d" / "2d" / "low" / "empty".
  */
  function expiryBadge(days: number | null): string {
    if (days === null) return ''
    if (days < 0) return `${days}d`
    if (days === 0) return 'today'
    return `${days}d`
  }

  function lowStockBadge(item: {
    currentWeightG: number | null
    thresholdG: number | null
    tareG?: number | null
    fullG?: number | null
  }): string {
    if (item.currentWeightG !== null && item.currentWeightG <= 0) return 'empty'
    const pct = percentFull(item)
    if (pct !== null) return `${pct}%`
    return 'low'
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
          class="stat-card"
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

            <ul class="tile-scroll" use:tileScrollFade>
              {#each data.actions.expiring as item (item.id)}
                {@const u = expiryUrgency(item.daysToExpiry)}
                <li class="tile-scroll__item">
                  <a
                    class="tile tile--{u}"
                    href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
                    aria-label="{item.name} — {formatExpiry(item.daysToExpiry)}"
                  >
                    <div class="tile__media">
                      {#if item.imageUrl}
                        <img
                          src={item.imageUrl}
                          alt=""
                          loading="lazy"
                          referrerpolicy="no-referrer"
                        />
                      {:else}
                        <span class="tile__placeholder" aria-hidden="true">
                          <IconPackage size={32} stroke={1.5} />
                        </span>
                      {/if}
                      <span class="tile__badge tile__badge--{u}">{expiryBadge(item.daysToExpiry)}</span>
                    </div>
                    <span class="tile__name">{item.name}</span>
                    <span class="tile__meta">{formatExpiry(item.daysToExpiry)}</span>
                  </a>
                </li>
              {/each}
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

            <ul class="tile-scroll" use:tileScrollFade>
              {#each data.actions.lowStock as item (item.id)}
                {@const u = lowStockUrgency(item)}
                <li class="tile-scroll__item">
                  <a
                    class="tile tile--{u}"
                    href="/shelves/{item.shelfId}#slot-{item.scaleIndex}"
                    aria-label="{item.name} — {formatLowStock(item)}"
                  >
                    <div class="tile__media">
                      {#if item.imageUrl}
                        <img
                          src={item.imageUrl}
                          alt=""
                          loading="lazy"
                          referrerpolicy="no-referrer"
                        />
                      {:else}
                        <span class="tile__placeholder" aria-hidden="true">
                          <IconPackage size={32} stroke={1.5} />
                        </span>
                      {/if}
                      <span class="tile__badge tile__badge--{u}">{lowStockBadge(item)}</span>
                    </div>
                    <span class="tile__name">{item.name}</span>
                    <span class="tile__meta">{formatLowStock(item)}</span>
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
        </article>
      </div>
    {/if}
  </section>

  <section class="shelves" aria-labelledby="shelves-heading">
    <div class="shelves__heading">
      <h2 id="shelves-heading" class="section-title">Shelves</h2>
      <div class="legend" bind:this={legendRoot}>
        <button
          type="button"
          class="legend__trigger"
          aria-label="Show colour legend"
          aria-expanded={legendOpen}
          aria-controls="shelves-legend"
          onclick={(e) => {
            e.stopPropagation()
            legendOpen = !legendOpen
          }}
        >
          <IconInfoCircle size={18} stroke={1.75} />
        </button>
        {#if legendOpen}
          <div
            id="shelves-legend"
            class="legend__panel"
            role="dialog"
            aria-label="What the slot colours mean"
          >
            <p class="legend__title">Slot colours</p>
            <ul class="legend__list">
              <li>
                <span class="legend__swatch legend__swatch--ok" aria-hidden="true"></span>
                <div>
                  <strong>Stocked</strong>
                  <span class="legend__hint">Has product, not expiring soon</span>
                </div>
              </li>
              <li>
                <span class="legend__swatch legend__swatch--warn" aria-hidden="true"></span>
                <div>
                  <strong>Heads up</strong>
                  <span class="legend__hint">Running low or expires within 2 days</span>
                </div>
              </li>
              <li>
                <span class="legend__swatch legend__swatch--crit" aria-hidden="true"></span>
                <div>
                  <strong>Act now</strong>
                  <span class="legend__hint">Expired or fully consumed</span>
                </div>
              </li>
              <li>
                <span class="legend__swatch legend__swatch--empty" aria-hidden="true"></span>
                <div>
                  <strong>Empty slot</strong>
                  <span class="legend__hint">No item assigned</span>
                </div>
              </li>
            </ul>
          </div>
        {/if}
      </div>
    </div>

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
  <!--
    Insights are streamed from the server (`data.insights` is a
    Promise). While it resolves we show a lightweight skeleton so the
    tab doesn't pop in late. {#await} settles synchronously on
    subsequent navigations because SvelteKit caches the resolved
    value in the data graph.
  -->
  {#await data.insights}
    <div role="tabpanel" id="panel-insights" aria-labelledby="tab-insights" class="insights insights--loading" aria-busy="true">
      <p class="insights__intro">
        Trends from your weight history. Use the time range to compare
        windows; arrows show change vs the previous period.
      </p>
      <div class="range-toggle range-toggle--skeleton" aria-hidden="true">
        <span class="skeleton-chip"></span>
        <span class="skeleton-chip"></span>
        <span class="skeleton-chip"></span>
      </div>
      <div class="overview overview--skeleton" aria-hidden="true">
        <div class="overview__metric"><span class="skeleton-line skeleton-line--lg"></span><span class="skeleton-line skeleton-line--sm"></span></div>
        <div class="overview__metric"><span class="skeleton-line skeleton-line--lg"></span><span class="skeleton-line skeleton-line--sm"></span></div>
        <div class="overview__metric"><span class="skeleton-line skeleton-line--lg"></span><span class="skeleton-line skeleton-line--sm"></span></div>
      </div>
      <div class="insight-card insight-card--skeleton" aria-hidden="true">
        <span class="skeleton-line skeleton-line--md"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-line skeleton-line--short"></span>
      </div>
      <div class="insight-card insight-card--skeleton" aria-hidden="true">
        <span class="skeleton-line skeleton-line--md"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-line skeleton-line--short"></span>
      </div>
      <span class="visually-hidden">Loading insights…</span>
    </div>
  {:then ins}
  {@const sparse = ins.daysOfHistory < ins.minDataDays}
  <div role="tabpanel" id="panel-insights" aria-labelledby="tab-insights" class="insights">
    <p class="insights__intro">
      Trends from your weight history. Use the time range to compare
      windows; arrows show change vs the previous period.
    </p>
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
  {:catch error}
    <div role="tabpanel" id="panel-insights" aria-labelledby="tab-insights" class="insights insights--error">
      <p class="insights__sparse-title">Couldn't load insights</p>
      <p class="insights__sparse-body">
        {error instanceof Error ? error.message : 'Please try refreshing the page.'}
      </p>
    </div>
  {/await}
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

  /*
    Sticky tab bar. Negative horizontal margins bleed it edge-to-edge
    inside the .dashboard's 1rem horizontal padding so scrolling
    content doesn't show through the sides as it passes underneath.
    Solid background matches --background so the tab stays opaque.
    z-index above the cards keeps shadows/animations from clipping it.
  */
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin: 0 -1rem 1.5rem;
    padding: 0 1rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--background);
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

  /*
    Quiet orientation line at the top of the Insights panel. Tells
    first-time users what they're looking at without taking up the
    visual weight of a full card. Sits above the range toggle so
    it's the first thing read.
  */
  .insights__intro {
    margin: 0 0 -0.25rem;
    font-size: 0.8rem;
    line-height: 1.4;
    opacity: 0.65;
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

  /*
    Skeleton state for the streamed Insights tab. Renders matching the
    real layout's outer rhythm (range chips → overview row → two
    cards) so the hand-off to real content doesn't shuffle the page.
  */
  .insights--loading {
    display: grid;
    gap: 1rem;
  }

  .range-toggle--skeleton,
  .overview--skeleton {
    display: flex;
    gap: 0.5rem;
  }

  .overview--skeleton .overview__metric {
    flex: 1;
    display: grid;
    gap: 0.35rem;
  }

  .insight-card--skeleton {
    display: grid;
    gap: 0.5rem;
    padding: 1rem;
    border: 1px solid rgba(51, 42, 38, 0.06);
    border-radius: var(--radius-lg);
    background: var(--surface, #fff);
  }

  .skeleton-line,
  .skeleton-chip {
    display: block;
    height: 0.85rem;
    border-radius: 6px;
    background: linear-gradient(
      90deg,
      rgba(51, 42, 38, 0.06) 0%,
      rgba(51, 42, 38, 0.12) 50%,
      rgba(51, 42, 38, 0.06) 100%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-line {
    width: 100%;
  }
  .skeleton-line--lg {
    height: 1.4rem;
    width: 60%;
  }
  .skeleton-line--md {
    height: 1rem;
    width: 40%;
  }
  .skeleton-line--sm {
    height: 0.7rem;
    width: 50%;
  }
  .skeleton-line--short {
    width: 70%;
  }

  .skeleton-chip {
    height: 1.6rem;
    width: 3.5rem;
    border-radius: 999px;
  }

  @keyframes skeleton-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-line,
    .skeleton-chip {
      animation: none;
    }
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .insights--error {
    background: rgba(192, 57, 43, 0.08);
    border: 1px solid rgba(192, 57, 43, 0.2);
    border-radius: var(--radius-lg);
    padding: 1rem 1.1rem;
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

  /*
    Stat cards sit side-by-side at every viewport so the user can
    compare "expiring" vs "low stock" at a glance. Each card hosts a
    horizontally-scrolling tile carousel; with ~150px of width per
    card on a narrow phone, tiles peek at ~1.5 visible — enough to
    signal scrollability while keeping the section compact.
  */
  .stat-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.75rem;
  }

  /*
    Cards intentionally have no surface chrome (no background / border
    / shadow) so the content floats on the page background and the
    image tiles below feel like the primary visual elements. The
    previous left-accent stripe used to differentiate "expiring" vs
    "low stock" cards visually; that role now falls to the count
    number which can pick up the urgency tint per card.
  */
  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0;
    min-width: 0;
  }

  .stat-card--muted {
    opacity: 0.55;
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
    align-content: flex-start;
    gap: 0.3rem;
    /*
      Reserve space for up to two rows of chips so the two stat-cards
      stay vertically aligned even when one has more buckets than the
      other (e.g. expiring shows expired+today+this-week → 2 rows,
      while low-stock only shows empty+low → 1 row). Sized off the
      chip metrics: ~1.5em line height per row + 0.3rem inter-row gap.
    */
    min-height: calc(2 * 1.5em + 0.3rem);
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

  /*
    ── Image-tile scroller (Now-section actions) ─────────────────────
    Horizontal carousel of fixed-width tiles with scroll-snap and a
    page-indicator strip underneath. Each card holds its own scroller;
    the two cards live side-by-side so users can compare "expiring"
    vs "low stock" at a glance. Tiles are intentionally small (~96px)
    so ~1.5 peek inside each card's narrow column, hinting that more
    content is scrollable. Reuses the same IntersectionObserver
    pattern as the shelf-detail slot carousels for consistency.
  */
  .tile-scroll {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    display: flex;
    /*
      Don't stretch children to match the tallest sibling — otherwise
      a tile with a long product name + meta caption pulls the whole
      row taller and the `.tile__media`'s `aspect-ratio: 1/1` loses
      to the parent's vertical stretch, leaving the frame visibly
      non-square. `flex-start` lets each tile size from its own
      content.
    */
    align-items: flex-start;
    gap: 0.5rem;
    overflow-x: auto;
    overflow-y: hidden;
    /*
      `proximity` instead of `mandatory` so wheel-driven smooth
      scrolls aren't interrupted by the browser yanking the offset
      back to the nearest tile mid-animation. Touch swipes still
      feel snappy because proximity engages when the user lets go
      close to a snap line.
    */
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;

    /*
      Soft right-edge fade only — toggled by the `tileScrollFade`
      action via `--fade-right` (0 = fully opaque, 1 = full fade).
      Left edge is always opaque so the first tile reads cleanly as
      the start of the row. `--fade-width` is the band size.
    */
    --fade-right: 0;
    --fade-width: 1.25rem;
    -webkit-mask-image: linear-gradient(
      to right,
      #000 0,
      #000 calc(100% - var(--fade-width)),
      rgba(0, 0, 0, calc(1 - var(--fade-right))) 100%
    );
    mask-image: linear-gradient(
      to right,
      #000 0,
      #000 calc(100% - var(--fade-width)),
      rgba(0, 0, 0, calc(1 - var(--fade-right))) 100%
    );
  }

  .tile-scroll::-webkit-scrollbar {
    display: none;
  }

  .tile-scroll__item {
    flex: 0 0 auto;
    /*
      Compact tile width tuned so a ~150px stat-card column shows
      one tile + a peek of the next. Larger sizes would hide the
      "scrollable" affordance; smaller would lose image legibility.
    */
    width: 6rem;
    scroll-snap-align: start;
    min-width: 0;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    color: inherit;
    text-decoration: none;
    min-width: 0;
  }

  .tile__media {
    position: relative;
    aspect-ratio: 1 / 1;
    width: 100%;
    box-sizing: border-box;
    /*
      `overflow: hidden` clips the absolutely-positioned image to
      the rounded box. Without the urgency-coloured frame the tile
      is photo-forward — the corner badge alone carries the status
      signal, keeping the layout clean and very iOS Photos-like.
    */
    overflow: hidden;
    border-radius: var(--radius-md, 12px);
    background: var(--surface);
    transition: transform 0.15s ease;
  }

  .tile:hover .tile__media,
  .tile:focus-visible .tile__media {
    transform: translateY(-1px);
  }

  .tile:focus-visible .tile__media {
    outline: 2px solid var(--matcha-deep);
    outline-offset: 2px;
  }

  /*
    Image + placeholder fill the media box exactly. Absolute
    positioning keeps an intrinsically-portrait image (e.g. a bottle)
    from pushing the parent's height past the 1:1 aspect ratio.
    `object-fit: cover` then crops it to fit the square — `width:
    auto` / `height: auto` would render the image at its natural
    size, zoomed in from the top-left corner.
  */
  .tile__media img,
  .tile__placeholder {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
    display: block;
  }

  .tile__placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--matcha-soft, rgba(132, 169, 140, 0.18));
    color: var(--matcha-deep, #5e7d68);
    opacity: 0.8;
  }

  /*
    Per-urgency colour tokens consumed by the corner badge. Set on
    the tile root so a future child (e.g. an overlay or progress
    indicator) can pick them up without needing its own modifier.
  */
  .tile--crit {
    --tile-badge-bg: var(--error, #c0392b);
    --tile-badge-fg: #fff;
  }
  .tile--warn {
    --tile-badge-bg: var(--warn, #d39e3a);
    --tile-badge-fg: #fff;
  }
  .tile--ok {
    --tile-badge-bg: var(--matcha, #84a98c);
    --tile-badge-fg: #fff;
  }

  .tile__badge {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    background: var(--tile-badge-bg);
    color: var(--tile-badge-fg);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1;
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius-pill, 999px);
    letter-spacing: 0.01em;
    /*
      Soft drop shadow gives the badge lift and anchors it against
      bright or cluttered product photos without adding a hard ring.
    */
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  }

  .tile__name {
    font-size: 0.8rem;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
  }

  .tile__meta {
    font-size: 0.7rem;
    opacity: 0.6;
    line-height: 1.1;
  }

  .shelves {
    margin-top: 1rem;
  }

  /*
    Heading row pairs the section title with the legend trigger.
    Keeping them on one flex row means the (i) sits inline with the
    title without disturbing the section's existing vertical rhythm.
  */
  .shelves__heading {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .shelves__heading .section-title {
    margin: 0;
  }

  /*
    Legend popover. `position: relative` on the wrapper anchors the
    absolutely-positioned panel; outside-click + Escape dismiss are
    handled in the script. Panel is right-anchored so it doesn't
    overflow on narrow screens.
  */
  .legend {
    position: relative;
    display: inline-flex;
  }

  .legend__trigger {
    background: transparent;
    border: none;
    color: inherit;
    opacity: 0.55;
    padding: 0.15rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    cursor: pointer;
    transition:
      opacity 0.15s ease,
      background 0.15s ease;
  }

  .legend__trigger:hover,
  .legend__trigger:focus-visible,
  .legend__trigger[aria-expanded='true'] {
    opacity: 1;
    background: rgba(51, 42, 38, 0.06);
  }

  .legend__panel {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 20;
    min-width: 15rem;
    max-width: min(20rem, calc(100vw - 2rem));
    padding: 0.85rem 0.95rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  .legend__title {
    margin: 0 0 0.55rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.6;
  }

  .legend__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .legend__list li {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    font-size: 0.85rem;
    line-height: 1.3;
  }

  .legend__list strong {
    display: block;
    font-weight: 600;
  }

  .legend__hint {
    display: block;
    font-size: 0.75rem;
    opacity: 0.65;
  }

  /*
    Swatches mirror the actual folder-cell styling so the popover
    can't drift out of sync. If the folder palette changes, update
    these in lockstep.
  */
  .legend__swatch {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    border-radius: var(--radius-xs, 4px);
    margin-top: 0.1rem;
  }
  .legend__swatch--ok {
    background: var(--matcha);
    border: 1px solid var(--matcha-deep);
  }
  .legend__swatch--warn {
    background: var(--warn);
    border: 1px solid var(--warn);
  }
  .legend__swatch--crit {
    background: var(--error, #c0392b);
    border: 1px solid var(--error, #c0392b);
  }
  .legend__swatch--empty {
    background: transparent;
    border: 1px dashed rgba(51, 42, 38, 0.4);
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
    Severity order: expired > depleted (item present, current ≤ 0) >
    urgent (expires ≤2d) > low (stock) > normal.
    `depleted` and `expired` both render red because both represent
    "must act now" states. Slots with no item assigned at all keep
    the implicit dashed-outline `--empty` style (unchanged).
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

  .folder__cell--depleted {
    background: var(--error, #c0392b);
    border-color: var(--error, #c0392b);
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
