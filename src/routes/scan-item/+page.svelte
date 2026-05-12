<script lang="ts">
  import { goto } from '$app/navigation'
  import { onMount } from 'svelte'
  import type { PageData } from './$types'
  import { ZONES } from '$lib/shelf'
  import { getLastShelfId, setLastShelfId } from '$lib/scan/lastShelf'
  import { IconCamera, IconArrowRight, IconAlertCircle } from '@tabler/icons-svelte'

  let { data }: { data: PageData } = $props()

  let selectedShelf = $state<string | null>(null)
  let selectedSlot = $state<number | null>(null)

  /*
    Fast-path: skip the picker entirely when we know which shelf the
    user normally targets. Requires both:
      - a remembered shelf that still exists in their account
      - at least one empty slot on that shelf
    Anything else falls through to the manual selector below so the
    user is never trapped on a shelf with no room.
  */
  onMount(() => {
    const lastShelfId = getLastShelfId()
    if (!lastShelfId) return
    const shelfExists = data.shelves?.some((s) => s.id === lastShelfId)
    if (!shelfExists) return
    const slots = data.slotsByShelf?.[lastShelfId] ?? []
    const firstEmpty = slots.find((s) => s.status === 'empty')
    if (!firstEmpty) return
    goto(
      `/scan/barcode?shelf_id=${encodeURIComponent(lastShelfId)}&slot=${firstEmpty.scale_index}&replace=0`,
      { replaceState: true },
    )
  })

  const activeShelfId = $derived(
    selectedShelf ?? data.shelves?.[0]?.id ?? null,
  )

  const selectedSlotData = $derived(
    selectedSlot !== null && activeShelfId
      ? (data.slotsByShelf?.[activeShelfId]?.find(
          (s) => s.scale_index === selectedSlot,
        ) ?? null)
      : null,
  )

  function selectShelf(id: string) {
    selectedShelf = id
    selectedSlot = null
  }

  function selectSlot(slot: number) {
    selectedSlot = slot
  }

  function getSlot(slotIndex: number) {
    const shelfId = activeShelfId
    if (!shelfId) return null
    return (
      data.slotsByShelf?.[shelfId]?.find(
        (s) => s.scale_index === slotIndex,
      ) ?? null
    )
  }

  function continueToScanner() {
    if (!activeShelfId || selectedSlot === null) return
    const slot = getSlot(selectedSlot)
    const replace = slot?.status === 'filled' ? '1' : '0'
    setLastShelfId(activeShelfId)
    goto(
      `/scan/barcode?shelf_id=${encodeURIComponent(activeShelfId)}&slot=${selectedSlot}&replace=${replace}`,
    )
  }
</script>

<svelte:head>
  <title>Scan item · ShelfAware</title>
</svelte:head>

<main class="scan-item">
  <header class="scan-item__header">
    <div class="scan-item__header-row">
      <a class="scan-item__back" href="/" aria-label="Back to dashboard">←</a>
      <h1 class="scan-item__title">Scan an item</h1>
    </div>
    <p class="scan-item__subtitle">
      Choose where this item should go, then scan its barcode.
    </p>
  </header>

  {#if !data.shelves || data.shelves.length === 0}
    <div class="empty">
      <div class="empty__icon"><IconAlertCircle size={28} stroke={1.75} /></div>
      <h2 class="empty__title">No shelves yet</h2>
      <p class="empty__body">
        Pair a shelf first, then come back here to scan items into its slots.
      </p>
      <a href="/setup" class="primary-btn">
        <IconCamera size={18} stroke={2} />
        Pair a shelf
      </a>
    </div>
  {:else}
    <section class="section">
      <h2 class="section__title">Shelf</h2>
      <div class="shelves">
        {#each data.shelves as shelf}
          <button
            type="button"
            class="shelf-chip"
            class:shelf-chip--active={activeShelfId === shelf.id}
            onclick={() => selectShelf(shelf.id)}
          >
            <span class="shelf-chip__name">{shelf.name}</span>
          </button>
        {/each}
      </div>
    </section>

    {#if activeShelfId}
      <section class="section">
        <h2 class="section__title">Slot</h2>
        <p class="section__hint">
          Pick an empty slot, or replace what's already in a filled one.
        </p>

        {#each ZONES as zone}
          <div class="zone">
            <h3 class="zone__label">{zone.label}</h3>
            <div class="slot-grid">
              {#each zone.slotIndices as slotIndex}
                {@const slot = getSlot(slotIndex)}
                <button
                  type="button"
                  class="slot"
                  class:slot--filled={slot?.status === 'filled'}
                  class:slot--selected={selectedSlot === slotIndex}
                  onclick={() => selectSlot(slotIndex)}
                >
                  <span class="slot__idx">Slot {slotIndex}</span>
                  <span class="slot__detail">
                    {#if slot?.status === 'filled'}
                      {slot.item?.product_name ?? slot.item?.barcode ?? 'Filled'}
                    {:else}
                      Empty
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </section>
    {/if}
  {/if}
</main>

{#if activeShelfId && selectedSlot !== null}
  <div class="continue-bar">
    <div class="continue-bar__inner">
      <div class="continue-bar__meta">
        <span class="continue-bar__hint">
          {selectedSlotData?.status === 'filled' ? 'Replacing' : 'New item'}
        </span>
        <span class="continue-bar__detail">
          Slot {selectedSlot}
        </span>
      </div>
      <button
        type="button"
        class="primary-btn"
        onclick={continueToScanner}
      >
        Continue
        <IconArrowRight size={18} stroke={2} />
      </button>
    </div>
  </div>
{/if}

<style>
  .scan-item {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 7rem;
  }

  .scan-item__header {
    margin-bottom: 1.5rem;
  }

  .scan-item__header-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.4rem;
  }

  .scan-item__back {
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

  .scan-item__back:hover {
    background: var(--background);
  }

  .scan-item__title {
    margin: 0;
    font-size: 1.6rem;
    letter-spacing: -0.01em;
    flex: 1;
    min-width: 0;
  }

  .scan-item__subtitle {
    margin: 0;
    color: var(--text);
    opacity: 0.7;
    line-height: 1.4;
  }

  .section {
    margin-bottom: 1.5rem;
  }

  .section__title {
    margin: 0 0 0.5rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text);
    opacity: 0.65;
  }

  .section__hint {
    margin: 0 0 0.85rem;
    font-size: 0.85rem;
    opacity: 0.7;
  }

  .shelves {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .shelf-chip {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 0.45rem 0.95rem;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text);
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }

  .shelf-chip:hover {
    background: var(--matcha-soft);
  }

  .shelf-chip--active {
    background: var(--matcha-soft);
    border-color: var(--matcha);
    color: var(--matcha-deep);
  }

  .zone {
    margin-bottom: 1rem;
  }

  .zone__label {
    margin: 0 0 0.45rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
  }

  .slot-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.55rem;
  }

  .slot {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.7rem 0.55rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font: inherit;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    min-height: 4.5rem;
    transition:
      background 0.15s ease,
      border-color 0.15s ease;
  }

  .slot:hover {
    background: var(--matcha-soft);
    border-color: var(--matcha);
  }

  .slot--filled {
    background: var(--surface);
  }

  .slot--selected {
    background: var(--matcha-soft);
    border-color: var(--matcha);
    box-shadow: 0 0 0 2px var(--matcha-soft);
  }

  .slot__idx {
    font-size: 0.75rem;
    font-weight: 600;
    opacity: 0.6;
  }

  .slot__detail {
    font-size: 0.85rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .empty {
    margin: 2rem auto;
    max-width: 24rem;
    padding: 2rem 1.5rem;
    text-align: center;
    background: var(--surface);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    box-shadow: 0 1px 2px rgba(51, 42, 38, 0.04);
  }

  .empty__icon {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    background: var(--matcha-soft);
    color: var(--matcha-deep);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .empty__icon :global(svg) {
    color: var(--matcha-deep);
  }

  .empty__title {
    margin: 0.25rem 0 0;
    font-size: 1.15rem;
    font-weight: 600;
  }

  .empty__body {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.45;
    opacity: 0.75;
  }

  .continue-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--surface);
    border-top: 1px solid var(--border);
    box-shadow: 0 -4px 18px rgba(20, 16, 14, 0.08);
    padding: 0.8rem 1rem calc(0.8rem + env(safe-area-inset-bottom, 0px));
    z-index: 60;
  }

  .continue-bar__inner {
    max-width: 640px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .continue-bar__meta {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
    min-width: 0;
  }

  .continue-bar__hint {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
  }

  .continue-bar__detail {
    font-size: 0.95rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .primary-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--text);
    color: var(--background);
    border: none;
    border-radius: var(--radius-pill);
    padding: 0.7rem 1.2rem;
    font: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    transition:
      background 0.15s ease,
      transform 0.05s ease;
  }

  .primary-btn :global(svg) {
    color: var(--background);
  }

  .primary-btn:hover {
    background: #1f1916;
  }

  .primary-btn:active {
    transform: translateY(1px);
  }
</style>
