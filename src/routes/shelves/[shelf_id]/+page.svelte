<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { enhance } from '$app/forms'
  import { invalidate, goto } from '$app/navigation'
  import { page } from '$app/state'
  import type { PageData } from './$types'
  import { ZONES } from '$lib/shelf'
  import {
    bucketFromState,
    BUCKET_LABEL,
    NOT_CALIBRATED_LABEL,
    computeState,
  } from '$lib/shelfState'
  import ProductDetailsModal from '$lib/components/ProductDetailsModal.svelte'
  import SyncStatusBadge from '$lib/components/SyncStatusBadge.svelte'
  import Sparkline from '$lib/components/Sparkline.svelte'
  import {
    formatDelta,
    formatExpiredAgo,
    formatGrams,
    formatGramsPerDay,
  } from '$lib/format'
  import {
    IconPencil,
    IconTrash,
    IconTrendingDown,
    IconAlertTriangle,
    IconLayoutGrid,
    IconDotsVertical,
  } from '@tabler/icons-svelte'

  const MAX_SHELF_NAME_LEN = 40
  let editingName = $state(false)
  let nameDraft = $state('')
  let renameError = $state<string | null>(null)
  let nameInputEl = $state<HTMLInputElement | undefined>(undefined)

  /*
    Shelf-level actions (rename / delete) are tucked behind a kebab
    menu next to the title so the destructive delete isn't a tap-by-
    accident risk while browsing items. The menu is dismissed on
    outside click and Escape, both wired up in onMount below.
  */
  let menuOpen = $state(false)
  let menuRoot = $state<HTMLDivElement | undefined>(undefined)

  function startEditName() {
    nameDraft = data.shelf.name
    renameError = null
    editingName = true
    menuOpen = false
    /*
      Focus the input on the next microtask so the element exists.
      Select-all so the user can immediately type a replacement.
    */
    queueMicrotask(() => {
      nameInputEl?.focus()
      nameInputEl?.select()
    })
  }

  function cancelEditName() {
    editingName = false
    renameError = null
  }

  function confirmDeleteShelf(e: Event) {
    const confirmed = confirm(
      `Delete "${data.shelf.name}"? This will remove all items and weight history. This cannot be undone.`,
    )
    if (!confirmed) {
      e.preventDefault()
    }
  }

  let { data }: { data: PageData } = $props()

  /*
    Items / Insights tabs. URL is the source of truth (`?tab=insights`)
    so deep links from the dashboard's insight rows can target a
    specific tab on the shelf page. localStorage is a fallback so the
    user's last choice survives a fresh visit. Mirrors the dashboard
    pattern intentionally.
  */
  const TAB_STORAGE_KEY = 'shelf:activeTab'
  type ShelfTab = 'items' | 'insights'

  function resolveInitialTab(): ShelfTab {
    const fromUrl = page.url.searchParams.get('tab')
    if (fromUrl === 'insights' || fromUrl === 'items') return fromUrl
    /*
      `localStorage` doesn't exist during SSR (and on some Node
      polyfills it exists as a non-functional stub), so gate on
      `window` instead of `typeof localStorage`. The initial SSR
      pass falls back to 'items'; the client-side $effect below
      reconciles with the stored value on hydration.
    */
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(TAB_STORAGE_KEY)
      if (stored === 'insights' || stored === 'items') return stored
    }
    return 'items'
  }

  let activeTab = $state<ShelfTab>(resolveInitialTab())

  $effect(() => {
    /*
      Keep URL + storage synced with the user's pick. Replace state so
      we don't pollute history with one entry per tab toggle.
    */
    const urlTab = page.url.searchParams.get('tab')
    if (activeTab === 'items') {
      if (urlTab) {
        const url = new URL(page.url)
        url.searchParams.delete('tab')
        void goto(url.toString(), {
          replaceState: true,
          keepFocus: true,
          noScroll: true,
        })
      }
    } else if (urlTab !== activeTab) {
      const url = new URL(page.url)
      url.searchParams.set('tab', activeTab)
      void goto(url.toString(), {
        replaceState: true,
        keepFocus: true,
        noScroll: true,
      })
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TAB_STORAGE_KEY, activeTab)
    }
  })

  function setRange(next: string) {
    /*
      Insights stream from the server; treat the URL as the source of
      truth for the current range so we can early-out without
      awaiting the promise.
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
    Tracks which slot is currently the leftmost-visible card in each
    zone's mobile carousel, keyed by zone id. Powers the page-indicator
    dots underneath each slot list. Untracked on desktop where the
    carousel collapses to a regular grid — every slot is visible at
    once, and the dots are hidden via CSS.
  */
  let visibleSlotByZone = $state<Record<string, number>>({})

  function trackVisibleSlot(node: HTMLElement, zoneId: string) {
    /*
      IntersectionObserver with the carousel as root tells us which
      slot is most centered. We pick the entry with the largest
      intersection ratio and map it back to its DOM index via the
      slot's position in the list. Cheap, accurate, and doesn't
      need a scroll listener firing per pixel.
    */
    const observer = new IntersectionObserver(
      (entries) => {
        let bestIdx = visibleSlotByZone[zoneId] ?? 0
        let bestRatio = 0
        for (const entry of entries) {
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio
            const idx = Array.prototype.indexOf.call(
              node.children,
              entry.target,
            )
            if (idx >= 0) bestIdx = idx
          }
        }
        if (visibleSlotByZone[zoneId] !== bestIdx) {
          visibleSlotByZone = { ...visibleSlotByZone, [zoneId]: bestIdx }
        }
      },
      { root: node, threshold: [0.5, 0.75, 1] },
    )

    for (const child of Array.from(node.children)) {
      observer.observe(child)
    }

    return {
      destroy() {
        observer.disconnect()
      },
    }
  }

  /*
    Live-updating sync timestamp. Server load gives us the initial
    value (max recorded_at across this shelf's items); we refresh it
    optimistically when a realtime weight_logs INSERT arrives for one
    of our item ids, and also schedule a backend invalidation so any
    other derived state (current_weight_g on shelf_items, fullness
    state) gets recomputed.
  */
  let liveLastSyncedAt = $state<string | null>(null);

  $effect(() => {
    if (
      data.lastSyncedAt &&
      (
        !liveLastSyncedAt ||
        data.lastSyncedAt > liveLastSyncedAt
      )
    ) {
      liveLastSyncedAt = data.lastSyncedAt;
    }
  });

  /*
    Live overrides keyed by shelf_items.id. When the Pi updates a row,
    we patch the slot card from the realtime payload and skip the
    server round-trip for the common case (just a weight reading
    bumping current_weight_g). Cleared whenever a fresh server load
    arrives, so any divergence self-heals.
  */
  type LiveItemPatch = {
    current_weight_g: number | null
    state: number | null
  }
  let liveItemPatches = $state<Record<string, LiveItemPatch>>({})

  $effect(() => {
    /*
      Discard local patches once the server load reflects them (or
      anything newer). Track the slot identity so we don't endlessly
      reset state during a single render pass.
    */
    void data.slots
    liveItemPatches = {}
  })

  let invalidateTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleRefresh() {
    /*
      Safety-net invalidate. Optimistic patches above usually cover
      the common case; this catches everything else (an item removed
      by another client, calibration change in product_catalog, etc.)
      without us having to subscribe to every related table.
    */
    if (invalidateTimer) return
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined
      invalidate('app:shelf-detail')
    }, 30_000)
  }

  let channel: ReturnType<typeof data.supabase.channel> | undefined

  /*
    Global dismissers for the kebab menu. Bound at mount so they're
    only active in the browser; cleaned up in onDestroy below.
  */
  function handleDocClick(e: MouseEvent) {
    if (!menuOpen) return
    if (menuRoot && !menuRoot.contains(e.target as Node)) {
      menuOpen = false
    }
  }
  function handleDocKey(e: KeyboardEvent) {
    if (menuOpen && e.key === 'Escape') {
      menuOpen = false
    }
  }

  onMount(() => {
    document.addEventListener('click', handleDocClick)
    document.addEventListener('keydown', handleDocKey)

    if (data.itemIds.length === 0) return
    channel = data.supabase
      .channel(`shelf-${data.shelf.id}-live`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'weight_logs',
          /*
            postgres_changes filter only supports a single equality,
            so we receive every weight_logs insert and filter
            client-side against the items we care about. Cheap.
          */
        },
        (payload) => {
          const row = payload.new as { item_id?: string; recorded_at?: string }
          if (!row?.item_id || !data.itemIds.includes(row.item_id)) return
          if (row.recorded_at && (!liveLastSyncedAt || row.recorded_at > liveLastSyncedAt)) {
            liveLastSyncedAt = row.recorded_at
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'shelf_items',
          filter: `shelf_id=eq.${data.shelf.id}`,
        },
        (payload) => {
          const row = payload.new as {
            id?: string
            current_weight_g?: number | null
          }
          if (!row?.id) return

          /*
            Find the calibration values from the initial server load
            so we can recompute fullness state with the same formula
            the server uses. If the item isn't in our load (e.g. it
            was added by someone else), fall through to a refresh.
          */
          const slot = data.slots.find(
            (s) => s.status === 'filled' && s.item.id === row.id,
          )
          if (!slot || slot.status !== 'filled') {
            scheduleRefresh()
            return
          }

          const newWeight = row.current_weight_g ?? null
          const newState = computeState(
            newWeight,
            slot.item.full_weight_g,
            slot.item.tare_weight_g,
          )

          liveItemPatches = {
            ...liveItemPatches,
            [row.id]: { current_weight_g: newWeight, state: newState },
          }
        },
      )
      .subscribe()
  })

  onDestroy(() => {
    if (invalidateTimer) clearTimeout(invalidateTimer)
    if (channel) channel.unsubscribe()
    document.removeEventListener('click', handleDocClick)
    document.removeEventListener('keydown', handleDocKey)
  })

  /**
   * Tracks which slot (by scale_index) currently has an in-flight
   * delete request. Used to disable both action buttons on that slot
   * while the request is pending so the user can't double-submit or
   * navigate away mid-delete. Null when no delete is running.
   */
  let deletingSlot = $state<number | null>(null)

  /**
   * The currently-open product details modal item, or null when no
   * modal is open. We pass the entire filled-slot item shape down so
   * the modal stays self-contained and doesn't have to look anything
   * up itself.
   */
  type FilledItem = Extract<PageData['slots'][number], { status: 'filled' }>['item']
  let activeItem = $state<FilledItem | null>(null)

  function openDetails(item: FilledItem) {
    activeItem = item
  }

  function closeDetails() {
    activeItem = null
  }

  function confirmDelete(productLabel: string) {
    return confirm(`Remove "${productLabel}" from this slot?`)
  }

  const dateFormatter = new Intl.DateTimeFormat('en-GB')

  function formatExpiryDate(expiryDate: string | null) {
    if (!expiryDate) {
      return 'No expiry date'
    }

    return dateFormatter.format(new Date(expiryDate))
  }

  function formatWeight(grams: number | null) {
    if (grams === null) return null
    return `${Math.round(grams)} g`
  }

  function stateLabel(state: number | null) {
    const bucket = bucketFromState(state)
    return bucket === null ? NOT_CALIBRATED_LABEL : BUCKET_LABEL[bucket]
  }

  function stateModifier(state: number | null) {
    const bucket = bucketFromState(state)
    return bucket === null ? 'uncalibrated' : bucket
  }

  /*
    Apply any pending live patches when reading slots, so the rendered
    card reflects the freshest weight/state we've heard about even
    when no server load has run yet. Patches are keyed by item id, so
    a slot replaced by another user invalidates the patch automatically.
  */
  function patchSlot(slot: PageData['slots'][number]) {
    if (slot.status !== 'filled') return slot
    const patch = liveItemPatches[slot.item.id]
    if (!patch) return slot
    return {
      ...slot,
      item: {
        ...slot.item,
        current_weight_g: patch.current_weight_g,
        state: patch.state,
      },
    }
  }

  function slotsForZone(zoneSlotIndices: readonly number[]) {
    return zoneSlotIndices
      .map((i) => data.slots.find((s) => s.scale_index === i))
      .filter((s): s is PageData['slots'][number] => s !== undefined)
      .map(patchSlot)
  }
</script>

<svelte:head>
  <title>{data.shelf.name} · shelfAware</title>
</svelte:head>

<main class="shelf-page">
  <header class="shelf-header">
    <a href="/" class="back-link" aria-label="Back to dashboard">←</a>
    {#if editingName}
      <form
        method="POST"
        action="?/renameShelf"
        class="shelf-title-form"
        use:enhance={() => {
          /*
            Optimistic-ish: clear the inline error on each submit. On
            failure the server returns a `rename.error` we surface; on
            success SvelteKit reruns the load and we close the editor.
          */
          renameError = null
          return async ({ result, update }) => {
            await update({ reset: false })
            if (
              result.type === 'failure' &&
              result.data &&
              typeof result.data === 'object' &&
              'rename' in result.data
            ) {
              const r = (result.data as { rename?: { error?: string } }).rename
              renameError = r?.error ?? 'Could not rename shelf.'
            } else if (result.type === 'success') {
              editingName = false
            }
          }
        }}
      >
        <input
          bind:this={nameInputEl}
          bind:value={nameDraft}
          name="name"
          type="text"
          class="shelf-title-input"
          maxlength={MAX_SHELF_NAME_LEN}
          required
          aria-label="Shelf name"
          aria-invalid={renameError ? 'true' : undefined}
          onkeydown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              cancelEditName()
            }
          }}
        />
        <button
          type="submit"
          class="shelf-title-btn shelf-title-btn--primary"
          disabled={nameDraft.trim().length === 0 || nameDraft.trim() === data.shelf.name}
        >
          Save
        </button>
        <button
          type="button"
          class="shelf-title-btn"
          onclick={cancelEditName}
        >
          Cancel
        </button>
      </form>
      {#if renameError}
        <p class="shelf-title-error" role="alert">{renameError}</p>
      {/if}
    {:else}
      <h1 class="shelf-title">{data.shelf.name}</h1>

      <div class="shelf-menu" bind:this={menuRoot}>
        <button
          type="button"
          class="shelf-menu__trigger"
          aria-label="Shelf settings"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <IconDotsVertical size={20} stroke={1.75} />
        </button>

        {#if menuOpen}
          <div class="shelf-menu__panel" role="menu">
            <button
              type="button"
              role="menuitem"
              class="shelf-menu__item"
              onclick={startEditName}
            >
              <IconPencil size={16} stroke={1.75} />
              <span>Rename shelf</span>
            </button>
            <form
              method="POST"
              action="?/deleteShelf"
              onsubmit={confirmDeleteShelf}
            >
              <button
                type="submit"
                role="menuitem"
                class="shelf-menu__item shelf-menu__item--danger"
              >
                <IconTrash size={16} stroke={1.75} />
                <span>Delete shelf</span>
              </button>
            </form>
          </div>
        {/if}
      </div>
    {/if}

    <SyncStatusBadge
      lastSeen={liveLastSyncedAt}
      hasItems={data.itemIds.length > 0}
    />
  </header>

  <div class="tabs" role="tablist" aria-label="Shelf view">
    <button
      type="button"
      id="tab-items"
      role="tab"
      class="tabs__btn"
      class:tabs__btn--active={activeTab === 'items'}
      aria-selected={activeTab === 'items'}
      aria-controls="panel-items"
      onclick={() => (activeTab = 'items')}
    >
      Items
    </button>
    <button
      type="button"
      id="tab-insights"
      role="tab"
      class="tabs__btn"
      class:tabs__btn--active={activeTab === 'insights'}
      aria-selected={activeTab === 'insights'}
      aria-controls="panel-insights"
      onclick={() => (activeTab = 'insights')}
    >
      Insights
    </button>
  </div>

  {#if activeTab === 'items'}
  <div role="tabpanel" id="panel-items" aria-labelledby="tab-items">
  {#each ZONES as zone (zone.id)}
    <section class="zone">
      <h2 class="zone-title">{zone.label}</h2>
      <ul class="slot-list" use:trackVisibleSlot={zone.id}>
        {#each slotsForZone(zone.slotIndices) as slot (slot.scale_index)}
          <li class="slot" id="slot-{slot.scale_index}">
            {#if slot.status === 'filled'}
              <article class="slot-card slot-card--filled">
                <!--
                  The card body itself is a button — tapping anywhere
                  on the image / name / status opens the details modal.
                  We deliberately keep the Replace + Delete actions as
                  siblings rather than nesting them inside this button,
                  since nested interactive elements aren't valid HTML
                  and break keyboard / assistive-tech behaviour.
                -->
                <button
                  type="button"
                  class="slot-card__body"
                  onclick={() => openDetails(slot.item)}
                  aria-label={`View details for ${slot.item.product_name ?? slot.item.barcode}`}
                >
                  <p class="slot-index">Slot {slot.scale_index}</p>
                  <div class="slot-image">
                    {#if slot.item.image_url}
                      <img
                        src={slot.item.image_url}
                        alt=""
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    {:else}
                      <div class="slot-image__placeholder" aria-hidden="true">
                        {(slot.item.product_name ?? slot.item.barcode)
                          .trim()
                          .charAt(0)
                          .toUpperCase() || '?'}
                      </div>
                    {/if}
                  </div>
                  <h3 class="slot-product">
                    {slot.item.product_name ?? slot.item.barcode}
                  </h3>
                  <p class="slot-state slot-state--{stateModifier(slot.item.state)}">
                    {#if slot.item.state !== null}
                      <span
                        class="slot-state__bar"
                        role="progressbar"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={Math.round(slot.item.state * 100)}
                        aria-label="Fullness: {stateLabel(slot.item.state)}"
                      >
                        <span
                          class="slot-state__bar-fill"
                          style="width: {Math.max(0, Math.min(100, slot.item.state * 100))}%"
                        ></span>
                      </span>
                    {:else}
                      <span class="slot-state__label">
                        {stateLabel(slot.item.state)}
                      </span>
                    {/if}
                  </p>
                  <p class="slot-expiry">
                    expires: {formatExpiryDate(slot.item.expiry_date)}
                  </p>
                </button>

                <div class="slot-actions">
                  <a
                    class="slot-btn slot-btn--replace"
                    href={`/scan/barcode?shelf_id=${encodeURIComponent(data.shelf.id)}&slot=${slot.scale_index}&replace=1`}
                    aria-disabled={deletingSlot === slot.scale_index ? 'true' : undefined}
                    tabindex={deletingSlot === slot.scale_index ? -1 : undefined}
                    aria-label={`Replace product in slot ${slot.scale_index}`}
                  >
                    Replace
                  </a>
                  <form
                    method="POST"
                    action="?/deleteItem"
                    use:enhance={({ cancel }) => {
                      const label = slot.status === 'filled'
                        ? (slot.item.product_name ?? slot.item.barcode)
                        : ''
                      if (!confirmDelete(label)) {
                        cancel()
                        return
                      }
                      deletingSlot = slot.scale_index
                      return async ({ update }) => {
                        await update()
                        deletingSlot = null
                      }
                    }}
                  >
                    <input type="hidden" name="scale_index" value={slot.scale_index} />
                    <button
                      type="submit"
                      class="slot-icon-btn slot-icon-btn--delete"
                      disabled={deletingSlot === slot.scale_index}
                      aria-label={`Delete product from slot ${slot.scale_index}`}
                      title="Delete"
                    >
                      {#if deletingSlot === slot.scale_index}
                        <span class="slot-icon-btn__spinner" aria-hidden="true"></span>
                      {:else}
                        <!-- Trash can: 24x24, single-color, follows currentColor -->
                        <svg
                          viewBox="0 0 24 24"
                          width="18"
                          height="18"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      {/if}
                    </button>
                  </form>
                </div>
              </article>
            {:else}
              <a
                class="slot-card slot-card--empty"
                href={`/scan/barcode?shelf_id=${encodeURIComponent(data.shelf.id)}&slot=${slot.scale_index}`}
              >
                <p class="slot-index">Slot {slot.scale_index}</p>
                <p class="slot-action">+ Add product</p>
              </a>
            {/if}
          </li>
        {/each}
      </ul>
      <div
        class="scroll-dots"
        role="presentation"
        aria-hidden="true"
      >
        {#each slotsForZone(zone.slotIndices) as slot, i (slot.scale_index)}
          <span
            class="scroll-dot"
            class:scroll-dot--active={(visibleSlotByZone[zone.id] ?? 0) === i}
          ></span>
        {/each}
      </div>
    </section>
  {/each}

  </div>
  {:else}
  <!--
    Per-shelf insights are streamed from the server so the Items tab
    can render the moment shelf metadata + slots are ready, without
    waiting on five heavy weight-log queries. While the Insights tab
    promise is pending we show a skeleton; the page is still
    interactive (tabs, kebab menu, etc.).
  -->
  {#await data.insights}
    <div role="tabpanel" id="panel-insights" aria-labelledby="tab-insights" class="insights insights--loading" aria-busy="true">
      <p class="insights__intro">
        Trends scoped to this shelf. Use the time range to compare
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
      Trends scoped to this shelf. Use the time range to compare
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
          Come back in a few days &mdash; once this shelf has built up a bit of
          weight history, you'll see what you eat through fastest, what's
          always running low, and what's been wasted.
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

    <!-- Shelf utilization (per-shelf only) -->
    <section class="insight-card" aria-labelledby="util-heading">
      <header class="insight-card__head">
        <span class="insight-card__icon insight-card__icon--matcha" aria-hidden="true">
          <IconLayoutGrid size={20} stroke={1.75} />
        </span>
        <div>
          <h2 id="util-heading" class="insight-card__title">Shelf utilization</h2>
          <p class="insight-card__subtitle">
            slots in use, last {ins.windowDays} days
          </p>
        </div>
      </header>

      {#if ins.utilization.series.length === 0}
        <p class="insight-card__empty">
          No activity logged on this shelf yet.
        </p>
      {:else}
        <div class="util-row">
          <div class="util-meta">
            <p class="util-meta__primary">
              <strong>{ins.utilization.currentFilled}</strong>
              <span>/ {ins.utilization.totalSlots} slots in use now</span>
            </p>
            <p class="util-meta__secondary">
              avg {ins.utilization.avgFilled.toFixed(1)} over window
            </p>
          </div>
          <Sparkline
            values={ins.utilization.series}
            width={120}
            height={32}
            strokeWidth={1.5}
            fill="var(--matcha-50, rgba(132, 169, 140, 0.18))"
          />
        </div>
      {/if}
    </section>

    <!-- Wasted summary -->
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
              <a class="insight-row" href="#slot-{item.scaleIndex}">
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
                    expired {formatExpiredAgo(item.expiryDate)} &middot;
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
          <p class="insight-card__subtitle">
            grams per day, last {ins.windowDays} days
          </p>
        </div>
      </header>

      {#if sparse || ins.fastestConsumed.length === 0}
        {#if sparse}
          <div class="skeleton skeleton--row"></div>
          <div class="skeleton skeleton--row"></div>
        {:else}
          <p class="insight-card__empty">
            Not enough movement on this shelf yet to rank consumption.
          </p>
        {/if}
      {:else}
        <ul class="insight-list">
          {#each ins.fastestConsumed as item (item.itemId)}
            <li>
              <a class="insight-row" href="#slot-{item.scaleIndex}">
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
                    {formatGramsPerDay(item.gPerDay)} &middot; {Math.round(item.daysObserved)}d observed
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
            Nothing has tripped a low-stock alert on this shelf in this window.
          </p>
        {/if}
      {:else}
        <ul class="insight-list">
          {#each ins.alwaysRunningLow as item (item.itemId)}
            <li>
              <a class="insight-row" href="#slot-{item.scaleIndex}">
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

<ProductDetailsModal item={activeItem} onclose={closeDetails} />

<style>
  .shelf-page {
    width: 100%;
    /*
      Bottom padding clears the fixed bottom-nav island so the last
      slot card / danger zone button never sits under it, without
      leaving a big scroll-past void of empty space.
    */
    padding: 1rem 1rem 5rem;
    box-sizing: border-box;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: 2.25rem;
    height: 2.25rem;
    font: inherit;
    font-size: 1rem;
    line-height: 1;
    color: var(--text);
    text-decoration: none;
    flex-shrink: 0;
  }

  .back-link:hover,
  .back-link:focus-visible {
    background: var(--background);
  }

  .shelf-header {
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .shelf-title {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.2;
    font-weight: 700;
  }

  /*
    Kebab "shelf settings" menu next to the title. We anchor a
    relatively-positioned wrapper around the trigger so the floating
    panel can be absolutely positioned beneath it without escaping the
    header layout.
  */
  .shelf-menu {
    position: relative;
    display: inline-flex;
  }

  .shelf-menu__trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    background: transparent;
    color: inherit;
    border-radius: var(--radius-pill);
    cursor: pointer;
    opacity: 0.65;
    transition: opacity 0.15s ease, background-color 0.15s ease;
  }

  .shelf-menu__trigger:hover,
  .shelf-menu__trigger:focus-visible,
  .shelf-menu__trigger[aria-expanded='true'] {
    opacity: 1;
    background: var(--background);
  }

  .shelf-menu__panel {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 30;
    min-width: 12rem;
    padding: 0.3rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .shelf-menu__panel form {
    margin: 0;
    display: flex;
  }

  .shelf-menu__item {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.5rem 0.65rem;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
    text-align: left;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .shelf-menu__item:hover,
  .shelf-menu__item:focus-visible {
    background: var(--background);
  }

  .shelf-menu__item--danger {
    color: var(--error, #c0392b);
  }

  .shelf-menu__item--danger:hover,
  .shelf-menu__item--danger:focus-visible {
    background: rgba(192, 57, 43, 0.08);
  }

  .shelf-title-form {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .shelf-title-input {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: inherit;
    min-width: 0;
    flex: 1 1 12rem;
  }

  .shelf-title-input[aria-invalid='true'] {
    border-color: var(--error, #c0392b);
  }

  .shelf-title-btn {
    padding: 0.4rem 0.8rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .shelf-title-btn:hover:not(:disabled),
  .shelf-title-btn:focus-visible:not(:disabled) {
    background: var(--background);
  }

  .shelf-title-btn--primary {
    background: var(--matcha);
    border-color: var(--matcha-deep);
    color: #fff;
  }

  .shelf-title-btn--primary:hover:not(:disabled),
  .shelf-title-btn--primary:focus-visible:not(:disabled) {
    background: var(--matcha-deep);
  }

  .shelf-title-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .shelf-title-error {
    margin: 0.25rem 0 0;
    font-size: 0.85rem;
    color: var(--error, #c0392b);
    flex-basis: 100%;
  }

  .zone {
    margin-bottom: 1.5rem;
  }

  .zone-title {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }

  .slot-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
  }

  /*
    On narrow viewports we drop the grid in favour of a horizontal
    scroll-snap carousel per zone. This mirrors a physical shelf
    visually (slot 0/1/2 sit side-by-side, just like the scales)
    and keeps the page compact compared to stacking three full-width
    cards vertically. Bleed the carousel into the page padding so
    cards can scroll edge-to-edge without a hard left margin.
  */
  /*
    Page-indicator dots beneath each carousel. Hidden on desktop
    where the grid layout renders every slot at once.
  */
  .scroll-dots {
    display: none;
  }

  @media (max-width: 480px) {
    .slot-list {
      display: flex;
      gap: 0.65rem;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x mandatory;
      scroll-padding-left: 1rem;
      padding: 0.25rem 1rem;
      margin: 0 -1rem;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .slot-list::-webkit-scrollbar {
      display: none;
    }

    .scroll-dots {
      display: flex;
      justify-content: center;
      gap: 0.35rem;
      margin-top: 0.6rem;
    }

    .scroll-dot {
      width: 0.4rem;
      height: 0.4rem;
      border-radius: 50%;
      background: var(--text);
      opacity: 0.18;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    .scroll-dot--active {
      opacity: 0.7;
      transform: scale(1.15);
    }
  }

  .slot {
    margin: 0;
    display: flex;
    border-radius: var(--radius-lg);
  }

  /*
    When the user arrives via a #slot-N deep link (from the
    dashboard "Now" section), pulse the targeted slot briefly so
    they can spot which item we just routed them to.
  */
  .slot:target .slot-card {
    animation: slot-target-pulse 1.6s ease-out 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .slot:target .slot-card {
      animation: none;
      box-shadow: 0 0 0 2px var(--matcha);
    }
  }

  @keyframes slot-target-pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(122, 139, 63, 0);
    }
    25% {
      box-shadow: 0 0 0 4px rgba(122, 139, 63, 0.55);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(122, 139, 63, 0);
    }
  }

  /*
    Slot sizing inside the mobile carousel. Pinned width keeps the
    rhythm consistent regardless of caption length, and scroll-snap
    aligns each card to the left edge so the user always lands on a
    clean slot boundary instead of mid-card.
  */
  @media (max-width: 480px) {
    .slot {
      flex: 0 0 11rem;
      scroll-snap-align: start;
    }

    /*
      Compact slot card on mobile: smaller padding, smaller image,
      smaller text. The carousel makes vertical space precious, so
      every card has to earn its height.
    */
    .slot-card {
      padding: 0.7rem;
      min-height: 0;
    }
    .slot-index {
      font-size: 0.68rem;
      margin-bottom: 0.15rem;
    }
    .slot-image {
      margin: 0.1rem 0 0.4rem;
    }
    .slot-image__placeholder {
      font-size: 1.4rem;
    }
    .slot-product {
      font-size: 0.88rem;
      line-height: 1.25;
    }
    .slot-state {
      margin-top: 0.35rem;
      font-size: 0.74rem;
    }
    .slot-actions {
      padding-top: 0.55rem;
      gap: 0.35rem;
    }
  }

  .slot-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    background: var(--surface);
    border: 1px solid transparent;
    border-radius: var(--radius-lg);
    padding: 1rem;
    min-height: 6rem;
    box-sizing: border-box;
    text-decoration: none;
    color: inherit;
  }

  .slot-card--empty {
    border: 1px dashed var(--border);
    background: transparent;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }

  .slot-card--empty:hover {
    background: var(--surface);
    border-color: var(--accent);
  }

  /*
    The card body is a real <button> wrapping the image / name / state
    so the entire upper region is one tap target for the details
    modal. We strip the user-agent button chrome and let it inherit
    the article's background, then mark up its hover/focus state with
    a subtle ring so users know it's interactive.
  */
  .slot-card__body {
    appearance: none;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    width: 100%;
    border-radius: var(--radius-md);
  }

  .slot-card__body:focus-visible {
    outline: 2px solid var(--accent, #4f46e5);
    outline-offset: 2px;
  }

  .slot-card__body:hover .slot-image,
  .slot-card__body:focus-visible .slot-image {
    transform: translateY(-1px);
  }

  .slot-actions {
    margin-top: auto;
    padding-top: 0.75rem;
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    /* Allow children to shrink below their intrinsic content width
       (otherwise long labels make the row overflow the card). */
    min-width: 0;
  }

  .slot-actions form {
    margin: 0;
    display: flex;
    flex: 0 0 auto;
  }

  .slot-btn {
    flex: 1 1 0;
    min-width: 0;
    /* Match the icon button's height and center text on both axes so
       the two action buttons sit on the same baseline visually. */
    height: 2.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    line-height: 1;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }

  .slot-btn--replace {
    background: var(--accent, #4f46e5);
    color: white;
  }

  .slot-btn--replace:hover,
  .slot-btn--replace:focus-visible {
    filter: brightness(1.1);
  }

  .slot-btn--replace[aria-disabled='true'] {
    opacity: 0.5;
    pointer-events: none;
  }

  .slot-icon-btn {
    flex: 0 0 auto;
    width: 2.25rem;
    height: 2.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }

  .slot-icon-btn--delete {
    color: #b91c1c;
    border-color: #fca5a5;
  }

  .slot-icon-btn--delete:hover:not(:disabled),
  .slot-icon-btn--delete:focus-visible:not(:disabled) {
    background: #fee2e2;
    border-color: #ef4444;
  }

  .slot-icon-btn:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .slot-icon-btn__spinner {
    width: 0.9rem;
    height: 0.9rem;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: slot-spin 0.7s linear infinite;
  }

  @keyframes slot-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .slot-index {
    margin: 0 0 0.25rem;
    font-size: 0.75rem;
    opacity: 0.6;
  }

  .slot-image {
    width: 100%;
    aspect-ratio: 1 / 1;
    margin: 0.25rem 0 0.5rem;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: rgba(0, 0, 0, 0.04);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.12s ease;
  }

  .slot-image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    /* Most OFF product photos are shot on white — a white background
       blends them into surrounding chrome on light themes. The neutral
       wash above gives them a subtle frame that works in both themes. */
    background: white;
  }

  .slot-image__placeholder {
    font-size: 1.75rem;
    font-weight: 600;
    color: var(--text);
    opacity: 0.5;
  }

  .slot-product {
    margin: 0;
    font-size: 1rem;
    line-height: 1.3;
    overflow-wrap: anywhere;
    /*
      Clamp long product names to 2 lines so every slot card has a
      predictable height regardless of how chatty OpenFoodFacts is.
      The full name is still available in the details modal that
      opens when the card is tapped.
    */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .slot-state {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    line-height: 1.3;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  /*
    Thin fullness bar that replaces the old colored dot. Inherits
    --state-color from the parent .slot-state--<bucket> modifier so
    a single class swap recolors the entire indicator. Hidden when
    state is null (uncalibrated) — see the {#if} in the markup.
  */
  .slot-state__bar {
    flex: 1 1 100%;
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--background);
    overflow: hidden;
    display: inline-block;
  }

  .slot-state__bar-fill {
    display: block;
    height: 100%;
    background: var(--state-color, currentColor);
    border-radius: inherit;
    transition: width 0.4s ease, background-color 0.3s ease;
  }

  .slot-state__label {
    color: var(--state-color, inherit);
    font-weight: 500;
  }

  .slot-state--empty {
    --state-color: #c0392b;
  }

  .slot-state--low {
    --state-color: #e67e22;
  }

  .slot-state--half {
    --state-color: #b8860b;
  }

  .slot-state--mostly_full {
    --state-color: #4a8a3f;
  }

  .slot-state--full {
    --state-color: #2e7d32;
  }

  .slot-state--uncalibrated {
    --state-color: #888;
    font-style: italic;
    opacity: 0.85;
  }

  .slot-expiry {
    margin: 0.35rem 0 0;
    font-size: 0.875rem;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .slot-action {
    margin: 0;
    font-size: 0.95rem;
    opacity: 0.85;
  }

  @media (min-width: 768px) {
    .shelf-page {
      max-width: 32rem;
      margin: 0 auto;
    }
  }

  /* ── Items / Insights tabs (matches dashboard underline style) ─────── */

  /*
    Sticky tab bar — bleeds edge-to-edge inside the shelf-page's 1rem
    horizontal padding so the row underneath doesn't show through as
    it scrolls. Solid background + z-index keep it opaque above the
    slot grid and insight cards.
  */
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin: 0 -1rem 1.25rem;
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

  /* ── Insights panel ────────────────────────────────────────────────── */

  .insights {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  /*
    Quiet orientation line at the top of the Insights panel — mirrors
    the dashboard's variant so the two read as the same surface.
  */
  .insights__intro {
    margin: 0 0 -0.25rem;
    font-size: 0.8rem;
    line-height: 1.4;
    opacity: 0.65;
  }

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
    Skeleton placeholders shown while the streamed insights payload
    resolves. Layout mirrors the real panel (range chips, overview
    row, two cards) so swap-in feels stable.
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
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
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

  /*
    Utilization card: header-style meta on the left, sparkline on the
    right so the trend reads at a glance without scrolling.
  */
  .util-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.85rem;
  }

  .util-meta__primary {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.2;
  }

  .util-meta__primary strong {
    font-size: 1.15rem;
    font-variant-numeric: tabular-nums;
    color: var(--matcha-deep);
  }

  .util-meta__primary span {
    opacity: 0.7;
  }

  .util-meta__secondary {
    margin: 0.2rem 0 0;
    font-size: 0.78rem;
    opacity: 0.65;
  }

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
</style>
