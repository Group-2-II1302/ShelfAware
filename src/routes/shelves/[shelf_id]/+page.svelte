<script lang="ts">
  import type { PageData } from './$types'
  import { ZONES } from '$lib/shelf'
  import {
    bucketFromState,
    BUCKET_LABEL,
    NOT_CALIBRATED_LABEL,
  } from '$lib/shelfState'

  let { data }: { data: PageData } = $props()

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
              <a
                class="slot-card slot-card--filled"
                href={`/scan/barcode?shelf_id=${encodeURIComponent(data.shelf.id)}&slot=${slot.scale_index}&replace=1`}
                aria-label={`Replace product in slot ${slot.scale_index}`}
              >
                <p class="slot-index">Slot {slot.scale_index}</p>
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
                <p class="slot-action slot-action--replace">Tap to replace</p>
              </a>
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

  .slot-card--filled {
    transition:
      transform 0.12s ease,
      border-color 0.15s ease;
    border-color: transparent;
  }

  .slot-card--filled:hover,
  .slot-card--filled:focus-visible {
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .slot-action--replace {
    margin-top: auto;
    padding-top: 0.5rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
  }

  .slot-index {
    margin: 0 0 0.25rem;
    font-size: 0.75rem;
    opacity: 0.6;
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
