<script lang="ts">
  import { enhance } from '$app/forms'
  import type { PageData } from './$types'
  import { ZONES } from '$lib/shelf'
  import {
    bucketFromState,
    BUCKET_LABEL,
    NOT_CALIBRATED_LABEL,
  } from '$lib/shelfState'

  let { data }: { data: PageData } = $props()

  /**
   * Tracks which slot (by scale_index) currently has an in-flight
   * delete request. Used to disable both action buttons on that slot
   * while the request is pending so the user can't double-submit or
   * navigate away mid-delete. Null when no delete is running.
   */
  let deletingSlot = $state<number | null>(null)

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

  function slotsForZone(zoneSlotIndices: readonly number[]) {
    return zoneSlotIndices
      .map((i) => data.slots.find((s) => s.scale_index === i))
      .filter((s): s is PageData['slots'][number] => s !== undefined)
  }
</script>

<svelte:head>
  <title>{data.shelf.name} · shelfAware</title>
</svelte:head>

<main class="shelf-page">
  <header class="shelf-header">
    <h1 class="shelf-title">
      {data.shelf.name}
    </h1>
  </header>

  {#each ZONES as zone (zone.id)}
    <section class="zone">
      <h2 class="zone-title">{zone.label}</h2>
      <ul class="slot-list">
        {#each slotsForZone(zone.slotIndices) as slot (slot.scale_index)}
          <li class="slot">
            {#if slot.status === 'filled'}
              <article class="slot-card slot-card--filled">
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
                  <span class="slot-state__dot" aria-hidden="true"></span>
                  <span class="slot-state__label">
                    {stateLabel(slot.item.state)}
                  </span>
                  {#if formatWeight(slot.item.current_weight_g)}
                    <span class="slot-weight">
                      · {formatWeight(slot.item.current_weight_g)}
                    </span>
                  {/if}
                </p>
                <p class="slot-expiry">
                  expires: {formatExpiryDate(slot.item.expiry_date)}
                </p>

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
    </section>
  {/each}
</main>

<style>
  .shelf-page {
    width: 100%;
    padding: 1rem;
    box-sizing: border-box;
  }

  .shelf-header {
    margin-bottom: 1rem;
  }

  .shelf-title {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.2;
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

  @media (max-width: 480px) {
    .slot-list {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .slot {
    margin: 0;
    display: flex;
  }

  .slot-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    background: var(--surface);
    border: 1px solid transparent;
    border-radius: 1rem;
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
    border-radius: 0.5rem;
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
    border-radius: 0.5rem;
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
    border-radius: 0.6rem;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.04);
    display: flex;
    align-items: center;
    justify-content: center;
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

  .slot-state__dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--state-color, currentColor);
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

  .slot-weight {
    opacity: 0.7;
    color: var(--text);
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
</style>
