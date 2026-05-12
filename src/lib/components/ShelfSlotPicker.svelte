<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import { IconChevronDown, IconX } from '@tabler/icons-svelte'
  import { ZONES } from '$lib/shelf'
  import type { ShelfSummary, SlotSummary } from '$lib/server/loadShelvesWithSlots'

  type Props = {
    shelves: ShelfSummary[]
    slotsByShelf: Record<string, SlotSummary[]>
    shelfId: string
    slot: number
    onChange: (next: { shelfId: string; slot: number; replace: boolean }) => void
  }

  let { shelves, slotsByShelf, shelfId, slot, onChange }: Props = $props()

  let open = $state(false)
  let stage = $state<'shelf' | 'slot'>('shelf')
  /*
    `draftShelf` is reset to the current `shelfId` every time the
    sheet opens (see `show()`). The initial empty string here just
    keeps Svelte 5 happy about not referencing a prop in $state
    initialiser — the value is meaningless until `show()` runs.
  */
  let draftShelf = $state<string>('')

  const currentShelfName = $derived(
    shelves.find((s) => s.id === shelfId)?.name ?? 'Unknown shelf',
  )

  function show() {
    draftShelf = shelfId
    stage = 'shelf'
    open = true
  }

  function hide() {
    open = false
  }

  function pickShelf(id: string) {
    draftShelf = id
    stage = 'slot'
  }

  function pickSlot(s: SlotSummary) {
    onChange({
      shelfId: draftShelf,
      slot: s.scale_index,
      replace: s.status === 'filled',
    })
    hide()
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) hide()
  }

  onMount(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKey)
    }
  })
  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKey)
    }
  })
</script>

<button type="button" class="picker__trigger" onclick={show}>
  <span class="picker__label">
    {currentShelfName}
    <span class="picker__sep">·</span>
    Slot {slot}
  </span>
  <IconChevronDown size={16} stroke={2} />
</button>

{#if open}
  <div
    class="picker__backdrop"
    onclick={hide}
    role="button"
    tabindex="-1"
    aria-label="Close picker"
    onkeydown={(e) => e.key === 'Enter' && hide()}
    transition:fade={{ duration: 150 }}
  ></div>

  <div
    class="picker__sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Choose shelf and slot"
    transition:fly={{ y: 300, duration: 240, easing: quintOut }}
  >
    <header class="picker__header">
      <h2 class="picker__title">
        {stage === 'shelf' ? 'Choose a shelf' : 'Choose a slot'}
      </h2>
      <button
        type="button"
        class="picker__close"
        onclick={hide}
        aria-label="Close"
      >
        <IconX size={20} stroke={2} />
      </button>
    </header>

    {#if stage === 'shelf'}
      <ul class="picker__shelf-list">
        {#each shelves as s}
          <li>
            <button
              type="button"
              class="picker__shelf-row"
              class:picker__shelf-row--active={s.id === shelfId}
              onclick={() => pickShelf(s.id)}
            >
              <span class="picker__shelf-name">{s.name}</span>
              {#if s.id === shelfId}
                <span class="picker__pill">Current</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="picker__slot-grid-wrap">
        <button
          type="button"
          class="picker__back"
          onclick={() => (stage = 'shelf')}
        >
          ← Change shelf
        </button>
        {#each ZONES as zone}
          <div class="picker__zone">
            <h3 class="picker__zone-label">{zone.label}</h3>
            <div class="picker__slot-grid">
              {#each zone.slotIndices as si}
                {@const s = slotsByShelf[draftShelf]?.find(
                  (x) => x.scale_index === si,
                )}
                <button
                  type="button"
                  class="picker__slot"
                  class:picker__slot--filled={s?.status === 'filled'}
                  class:picker__slot--current={draftShelf === shelfId && si === slot}
                  onclick={() => s && pickSlot(s)}
                  disabled={!s}
                >
                  <span class="picker__slot-idx">Slot {si}</span>
                  <span class="picker__slot-detail">
                    {#if s?.status === 'filled'}
                      {s.item?.product_name ?? s.item?.barcode ?? 'Filled'}
                    {:else}
                      Empty
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .picker__trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 0.4rem 0.8rem 0.4rem 0.9rem;
    font: inherit;
    font-size: 0.88rem;
    color: var(--text);
    cursor: pointer;
    max-width: 100%;
  }

  .picker__trigger:hover {
    background: var(--background);
  }

  .picker__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .picker__sep {
    margin: 0 0.35rem;
    opacity: 0.5;
  }

  .picker__backdrop {
    position: fixed;
    inset: 0;
    background: rgba(20, 16, 14, 0.4);
    z-index: 80;
  }

  .picker__sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 81;
    background: var(--surface);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding: 1rem 1rem 1.25rem;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 -8px 30px rgba(20, 16, 14, 0.18);
    box-sizing: border-box;
  }

  .picker__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .picker__title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .picker__close {
    background: transparent;
    border: none;
    color: var(--text);
    padding: 0.25rem;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .picker__close:hover {
    background: var(--background);
  }

  .picker__shelf-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .picker__shelf-row {
    width: 100%;
    background: var(--background);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    padding: 0.8rem 0.9rem;
    font: inherit;
    color: var(--text);
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
  }

  .picker__shelf-row:hover {
    background: var(--matcha-soft);
  }

  .picker__shelf-row--active {
    border-color: var(--matcha);
    background: var(--matcha-soft);
  }

  .picker__shelf-name {
    font-weight: 600;
  }

  .picker__pill {
    background: var(--matcha);
    color: var(--background);
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border-radius: var(--radius-pill);
    font-weight: 600;
  }

  .picker__back {
    background: transparent;
    border: none;
    color: var(--text);
    opacity: 0.7;
    font: inherit;
    font-size: 0.88rem;
    padding: 0.25rem 0;
    margin-bottom: 0.5rem;
    cursor: pointer;
  }

  .picker__back:hover {
    opacity: 1;
  }

  .picker__zone {
    margin-bottom: 0.8rem;
  }

  .picker__zone-label {
    margin: 0 0 0.4rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.65;
  }

  .picker__slot-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .picker__slot {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font: inherit;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    min-height: 4rem;
  }

  .picker__slot:hover:not(:disabled) {
    background: var(--matcha-soft);
    border-color: var(--matcha);
  }

  .picker__slot--filled {
    background: var(--surface);
  }

  .picker__slot--current {
    border-color: var(--matcha);
    background: var(--matcha-soft);
  }

  .picker__slot-idx {
    font-size: 0.78rem;
    font-weight: 600;
    opacity: 0.7;
  }

  .picker__slot-detail {
    font-size: 0.82rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
