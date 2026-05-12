<script lang="ts">
  /**
   * Modal that displays the OpenFoodFacts metadata stored alongside a
   * shelf item. Receives the full filled-slot item shape from the
   * shelves page so we don't have to re-fetch anything client-side.
   *
   * Built on top of the native <dialog> element to inherit a11y for
   * free (focus trap, Esc to close, restoration of focus on close).
   * Animations are layered on top via the [open] attribute and the
   * ::backdrop pseudo-element.
   */

  type Item = {
    barcode: string
    product_name: string | null
    brand: string | null
    image_url: string | null
    full_weight_g: number | null
    current_weight_g: number | null
    expiry_date: string | null
    nutrition_facts: Record<string, unknown> | null
  }

  let { item, onclose }: { item: Item | null; onclose: () => void } = $props()

  let dialogEl: HTMLDialogElement | undefined = $state()

  /*
    Open/close imperatively whenever the parent toggles `item`. We rely
    on showModal() rather than the open attribute because only the
    former enables the native focus trap, ::backdrop, and inert-page
    behaviour. close() is fired in response to backdrop click, the Esc
    key (handled natively), or the close button.
  */
  $effect(() => {
    if (!dialogEl) return
    if (item && !dialogEl.open) {
      dialogEl.showModal()
    } else if (!item && dialogEl.open) {
      dialogEl.close()
    }
  })

  function handleBackdropClick(event: MouseEvent) {
    /*
      Native <dialog> backdrop clicks bubble up to the dialog itself —
      detect this by checking that the click target IS the dialog
      element (not one of its children). This intentionally treats
      clicks on padding around the inner panel as backdrop clicks too,
      which feels right.
    */
    if (event.target === dialogEl) {
      onclose()
    }
  }

  function handleClose() {
    /*
      Fired by both backdrop click handlers and the native Esc key.
      Always notify the parent so its state stays in sync with the
      actual dialog open state.
    */
    onclose()
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const dateFormatter = new Intl.DateTimeFormat('en-GB')

  function formatExpiry(d: string | null) {
    if (!d) return 'No expiry date'
    return dateFormatter.format(new Date(d))
  }

  function formatWeight(g: number | null) {
    if (g === null || g === undefined) return null
    return `${Math.round(g)} g`
  }

  /*
    OpenFoodFacts puts nutrition values under `nutriments` keyed like
    "energy-kcal_100g", "fat_100g", etc. We pick the canonical "per
    100g" set since it's the most consistently populated. Quantities
    that aren't numeric (or are zero with no unit) just don't render.
  */
  type NutrientRow = { label: string; key: string; unit: string }
  const NUTRIENT_ROWS: NutrientRow[] = [
    { label: 'Energy',        key: 'energy-kcal_100g', unit: 'kcal' },
    { label: 'Fat',           key: 'fat_100g',         unit: 'g'    },
    { label: '— saturates',   key: 'saturated-fat_100g', unit: 'g'  },
    { label: 'Carbohydrates', key: 'carbohydrates_100g', unit: 'g'  },
    { label: '— sugars',      key: 'sugars_100g',      unit: 'g'    },
    { label: 'Fibre',         key: 'fiber_100g',       unit: 'g'    },
    { label: 'Protein',       key: 'proteins_100g',    unit: 'g'    },
    { label: 'Salt',          key: 'salt_100g',        unit: 'g'    },
  ]

  /*
    Postgres `jsonb` columns normally come back from supabase-js as
    real objects, but defensive parsing here means a stringified value
    (e.g. someone double-encoding nutrition_facts somewhere upstream)
    won't silently render the modal as empty. Returns null if parsing
    fails or the input isn't an object.
  */
  function asObject(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        return null
      }
    }
    return null
  }

  const facts = $derived(asObject(item?.nutrition_facts))

  /*
    Nutri-Score's well-known "unknown" / "not-applicable" sentinels
    mean OFF couldn't compute a grade — render nothing in that case
    rather than a confusing badge.
  */
  function meaningfulGrade(g: unknown): string | null {
    if (typeof g !== 'string') return null
    const lower = g.toLowerCase()
    if (lower === 'unknown' || lower === 'not-applicable' || lower === '') return null
    return lower
  }

  const nutriments       = $derived(asObject(facts?.nutriments))
  const ingredientsText  = $derived(typeof facts?.ingredients_text === 'string' ? facts.ingredients_text : null)
  /*
    OFF occasionally returns the same allergen tag more than once
    (e.g. "en:gluten" listed for both noodles and seasoning). Dedupe
    so the keyed each block doesn't error and the chip list stays
    visually clean.
  */
  const allergensTags    = $derived(
    Array.isArray(facts?.allergens_tags)
      ? Array.from(new Set(facts.allergens_tags as string[]))
      : [],
  )
  const nutriscoreGrade  = $derived(meaningfulGrade(facts?.nutriscore_grade))
  const novaGroup        = $derived(typeof facts?.nova_group === 'number' ? facts.nova_group : null)

  const presentNutrients = $derived(
    NUTRIENT_ROWS.filter((row) => {
      const v = nutriments?.[row.key]
      return typeof v === 'number' && !isNaN(v)
    }),
  )

  /**
   * Strip OFF's tag prefix ("en:") and humanise the remainder. Also
   * removes the language code so allergen tags read naturally as
   * "milk", "soybeans" instead of "en:milk".
   */
  function humaniseTag(tag: string) {
    return tag
      .replace(/^[a-z]{2}:/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  }

  /*
    Heuristic: if NONE of the optional sections have any data, surface
    a single "no data" notice instead of rendering several empty
    panels. The basic identity block (image / name / weight / expiry)
    always renders.
  */
  const hasAnyOFFData = $derived(
    presentNutrients.length > 0 ||
      !!ingredientsText ||
      allergensTags.length > 0 ||
      !!nutriscoreGrade ||
      novaGroup !== null,
  )
</script>

<dialog
  bind:this={dialogEl}
  onclick={handleBackdropClick}
  onclose={handleClose}
  class="product-modal"
  aria-labelledby="product-modal-title"
>
  {#if item}
    <div class="modal-panel">
      <button
        type="button"
        class="modal-close"
        onclick={() => onclose()}
        aria-label="Close"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" />
          <path d="M6 6l12 12" />
        </svg>
      </button>

      <header class="modal-hero">
        <div class="modal-hero__image">
          {#if item.image_url}
            <img src={item.image_url} alt="" loading="lazy" referrerpolicy="no-referrer" />
          {:else}
            <div class="modal-hero__placeholder" aria-hidden="true">
              {(item.product_name ?? item.barcode).trim().charAt(0).toUpperCase() || '?'}
            </div>
          {/if}
        </div>
        <div class="modal-hero__text">
          <h2 id="product-modal-title" class="modal-title">
            {item.product_name ?? item.barcode}
          </h2>
          {#if item.brand}
            <p class="modal-brand">{item.brand}</p>
          {/if}
          {#if nutriscoreGrade || novaGroup !== null}
            <div class="modal-badges">
              {#if nutriscoreGrade}
                <span
                  class="badge badge--nutriscore badge--nutriscore-{nutriscoreGrade.toLowerCase()}"
                  title="Nutri-Score"
                >
                  Nutri-Score {nutriscoreGrade.toUpperCase()}
                </span>
              {/if}
              {#if novaGroup !== null}
                <span class="badge badge--nova" title="NOVA processing group (1=unprocessed, 4=ultra-processed)">
                  NOVA {novaGroup}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      </header>

      <section class="modal-section">
        <h3 class="modal-section__title">Slot info</h3>
        <dl class="modal-meta">
          <div>
            <dt>Barcode</dt>
            <dd>{item.barcode}</dd>
          </div>
          {#if formatWeight(item.full_weight_g)}
            <div>
              <dt>Full weight</dt>
              <dd>{formatWeight(item.full_weight_g)}</dd>
            </div>
          {/if}
          {#if formatWeight(item.current_weight_g)}
            <div>
              <dt>Current weight</dt>
              <dd>{formatWeight(item.current_weight_g)}</dd>
            </div>
          {/if}
          <div>
            <dt>Expires</dt>
            <dd>{formatExpiry(item.expiry_date)}</dd>
          </div>
        </dl>
      </section>

      {#if presentNutrients.length > 0}
        <section class="modal-section">
          <h3 class="modal-section__title">Nutrition <small>per 100 g</small></h3>
          <table class="modal-nutrition">
            <tbody>
              {#each presentNutrients as row}
                <tr>
                  <th scope="row">{row.label}</th>
                  <td>
                    {(nutriments![row.key] as number).toFixed(1)} {row.unit}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}

      {#if ingredientsText}
        <section class="modal-section">
          <h3 class="modal-section__title">Ingredients</h3>
          <p class="modal-ingredients">{ingredientsText}</p>
        </section>
      {/if}

      {#if allergensTags.length > 0}
        <section class="modal-section">
          <h3 class="modal-section__title">Allergens</h3>
          <ul class="modal-allergens">
            {#each allergensTags as tag (tag)}
              <li class="allergen-chip">{humaniseTag(tag)}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if !hasAnyOFFData}
        <section class="modal-section">
          <p class="modal-empty">
            No nutrition data on file for this product. It may have been
            added before extra metadata was being saved, or wasn't
            available from OpenFoodFacts at the time. Replacing the
            slot will refresh the data.
          </p>
        </section>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  /* ── Native <dialog> reset ─────────────────────────────────────────────── */
  .product-modal {
    border: none;
    padding: 0;
    background: transparent;
    color: inherit;
    /* Take over our own positioning so the bottom-sheet variant can
       slide from the bottom of the viewport instead of being stuck
       in the center. */
    margin: 0;
    max-width: none;
    max-height: none;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .product-modal::backdrop {
    background: rgba(0, 0, 0, 0.45);
    /* Fade backdrop in. closed-state values come from the unset
       behaviour of ::backdrop on a closed <dialog>. */
    animation: backdrop-fade 0.2s ease-out;
  }

  /*
    Layout: bottom sheet on mobile.
    Scoped to [open] so a closed <dialog> falls back to the
    user-agent default (display: none) and doesn't keep occupying
    a viewport's worth of scroll height behind the scenes.
  */
  .product-modal[open] {
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .modal-panel {
    background: var(--surface, #fff);
    color: var(--text, inherit);
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    /*
      Thin overlay scrollbar that sits inside the rounded panel
      rather than the gutter that browsers reserve outside the
      border-radius. Firefox uses scrollbar-width / scrollbar-color;
      WebKit needs ::-webkit-scrollbar. Both fall back gracefully to
      the platform default when the property is unsupported.
    */
    scrollbar-width: thin;
    scrollbar-color: rgba(51, 42, 38, 0.25) transparent;
    scrollbar-gutter: stable;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding: 1.25rem 1.25rem 1.5rem;
    position: relative;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.18);
    box-sizing: border-box;
    animation: panel-slide-up 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .modal-panel::-webkit-scrollbar {
    width: 6px;
  }

  .modal-panel::-webkit-scrollbar-track {
    background: transparent;
    margin: 0.75rem 0;
  }

  .modal-panel::-webkit-scrollbar-thumb {
    background: rgba(51, 42, 38, 0.25);
    border-radius: var(--radius-pill);
  }

  .modal-panel::-webkit-scrollbar-thumb:hover {
    background: rgba(51, 42, 38, 0.4);
  }

  /* ── Layout: centered dialog on desktop ────────────────────────────────── */
  @media (min-width: 640px) {
    .product-modal[open] {
      align-items: center;
    }

    .modal-panel {
      max-width: 32rem;
      border-radius: var(--radius-xl);
      animation: panel-pop-in 0.22s cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
    }
  }

  /* ── Close button ──────────────────────────────────────────────────────── */
  .modal-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: rgba(0, 0, 0, 0.06);
    color: inherit;
    border-radius: 50%;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .modal-close:hover,
  .modal-close:focus-visible {
    background: rgba(0, 0, 0, 0.12);
  }

  /* ── Hero ──────────────────────────────────────────────────────────────── */
  .modal-hero {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding-right: 2.5rem; /* leave room for close button */
    margin-bottom: 1rem;
  }

  .modal-hero__image {
    flex: 0 0 5rem;
    width: 5rem;
    height: 5rem;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: rgba(0, 0, 0, 0.04);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-hero__image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: white;
  }

  .modal-hero__placeholder {
    font-size: 1.75rem;
    font-weight: 600;
    opacity: 0.5;
  }

  .modal-hero__text {
    min-width: 0;
    flex: 1;
  }

  .modal-title {
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .modal-brand {
    margin: 0.15rem 0 0;
    font-size: 0.9rem;
    opacity: 0.7;
  }

  /* ── Badges (Nutri-Score / NOVA) ──────────────────────────────────────── */
  .modal-badges {
    margin-top: 0.5rem;
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.3;
    color: white;
    background: #6b7280;
  }

  .badge--nutriscore-a { background: #1f8f4a; }
  .badge--nutriscore-b { background: #74b73e; }
  .badge--nutriscore-c { background: #efbf3a; color: #2a2200; }
  .badge--nutriscore-d { background: #ef7e2e; }
  .badge--nutriscore-e { background: #d92d27; }

  .badge--nova { background: #4b5563; }

  /* ── Sections ──────────────────────────────────────────────────────────── */
  .modal-section {
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 0.85rem;
    margin-top: 0.85rem;
  }

  .modal-section:first-of-type {
    border-top: none;
    padding-top: 0;
    margin-top: 0;
  }

  .modal-section__title {
    margin: 0 0 0.5rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.65;
    font-weight: 600;
  }

  .modal-section__title small {
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
    font-weight: 400;
    margin-left: 0.35rem;
  }

  /* ── Meta ─────────────────────────────────────────────────────────────── */
  .modal-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem 1rem;
    margin: 0;
  }

  .modal-meta > div {
    min-width: 0;
  }

  .modal-meta dt {
    font-size: 0.75rem;
    opacity: 0.6;
  }

  .modal-meta dd {
    margin: 0.1rem 0 0;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  /* ── Nutrition ────────────────────────────────────────────────────────── */
  .modal-nutrition {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  .modal-nutrition tr + tr th,
  .modal-nutrition tr + tr td {
    border-top: 1px solid rgba(0, 0, 0, 0.06);
  }

  .modal-nutrition th {
    text-align: left;
    font-weight: 400;
    padding: 0.4rem 0;
    opacity: 0.85;
  }

  .modal-nutrition td {
    text-align: right;
    padding: 0.4rem 0;
    font-variant-numeric: tabular-nums;
  }

  /* ── Ingredients & allergens ──────────────────────────────────────────── */
  .modal-ingredients {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
    opacity: 0.9;
    overflow-wrap: anywhere;
  }

  .modal-allergens {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .allergen-chip {
    background: #fee2e2;
    color: #991b1b;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
  }

  /* ── Empty state ──────────────────────────────────────────────────────── */
  .modal-empty {
    margin: 0;
    font-size: 0.9rem;
    opacity: 0.7;
    line-height: 1.5;
  }

  /* ── Animations ───────────────────────────────────────────────────────── */
  @keyframes backdrop-fade {
    from { background: rgba(0, 0, 0, 0); }
    to   { background: rgba(0, 0, 0, 0.45); }
  }

  @keyframes panel-slide-up {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  @keyframes panel-pop-in {
    from { transform: scale(0.96); opacity: 0; }
    to   { transform: scale(1);    opacity: 1; }
  }

  /* Reduced-motion users get the modal but no slide/scale. */
  @media (prefers-reduced-motion: reduce) {
    .modal-panel {
      animation: none;
    }
    .product-modal::backdrop {
      animation: none;
    }
  }
</style>
