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
  import { deserialize } from '$app/forms'
  import type { ActionResult } from '@sveltejs/kit'

  type Item = {
    id: string
    barcode: string
    product_name: string | null
    brand: string | null
    image_url: string | null
    full_weight_g: number | null
    /**
     * Tare (empty container) weight from product_catalog. Optional;
     * when present it's used for more accurate fullness math on the
     * slot card. Editable here.
     */
    tare_weight_g: number | null
    current_weight_g: number | null
    expiry_date: string | null
    nutrition_facts: Record<string, unknown> | null
  }

  /**
   * Patch shape the modal hands back to the parent after a successful
   * save. The parent merges this into its `liveItemPatches` so the
   * slot card reflects the change immediately, then triggers a
   * server invalidation in the background to reconcile.
   */
  export type ItemEditPatch =
    | { kind: 'expiry'; itemId: string; expiry_date: string | null }
    | {
        kind: 'product'
        itemId: string
        barcode: string
        product_name?: string
        full_weight_g?: number
        tare_weight_g?: number | null
      }

  let {
    item,
    onclose,
    onSave,
  }: {
    item: Item | null
    onclose: () => void
    /*
      Optional save callback. When omitted the edit affordances are
      hidden entirely so the modal can still be used as a read-only
      viewer (e.g. on routes that don't expose update actions).
    */
    onSave?: (patch: ItemEditPatch) => Promise<void> | void
  } = $props()

  const canEdit = $derived(typeof onSave === 'function')

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

  // ── Inline editing ────────────────────────────────────────────────────────
  /*
    One field can be in edit mode at a time. The draft value lives
    here so we don't mutate the parent's data optimistically; we only
    commit after the server confirms the write. `editError` is per-
    field-instance because users can only see one editor at a time.
  */
  type EditField = 'product_name' | 'full_weight_g' | 'tare_weight_g' | 'expiry_date'
  let editingField = $state<EditField | null>(null)
  let editDraft    = $state<string>('')
  let editError    = $state<string | null>(null)
  let editBusy     = $state(false)
  let editInput    = $state<HTMLInputElement | null>(null)

  function startEdit(field: EditField) {
    if (!item || !canEdit) return
    editingField = field
    editError = null
    if (field === 'product_name') editDraft = item.product_name ?? ''
    else if (field === 'full_weight_g') editDraft = item.full_weight_g != null ? String(Math.round(item.full_weight_g)) : ''
    else if (field === 'tare_weight_g') editDraft = item.tare_weight_g != null ? String(Math.round(item.tare_weight_g)) : ''
    else if (field === 'expiry_date')   editDraft = item.expiry_date ?? ''
    queueMicrotask(() => editInput?.focus())
  }

  function cancelEdit() {
    if (editBusy) return
    editingField = null
    editError = null
  }

  /*
    Reset edit state whenever the modal target changes. Without this
    a half-finished edit on item A would briefly leak into item B
    when the user closes one and opens another.
  */
  $effect(() => {
    void item?.id
    editingField = null
    editError = null
    editBusy = false
  })

  async function postForm(action: string, fields: Record<string, string>) {
    const body = new FormData()
    for (const [k, v] of Object.entries(fields)) body.append(k, v)
    /*
      `x-sveltekit-action` tells SvelteKit to dispatch to the form
      action handler in +page.server.ts (rather than +server.ts when
      one exists alongside) and to return a serialised ActionResult.
      We use `deserialize` from $app/forms because the payload may
      include Date/BigInt and friends which JSON.parse can't restore.
    */
    const res = await fetch(action, {
      method: 'POST',
      body,
      headers: { 'x-sveltekit-action': 'true' },
    })
    const result = deserialize(await res.text()) as ActionResult
    if (result.type === 'success') {
      return (result.data ?? {}) as Record<string, unknown>
    }
    if (result.type === 'failure') {
      const data = (result.data ?? {}) as Record<string, unknown>
      const inner =
        (data.editProduct as { error?: string } | undefined) ??
        (data.editExpiry as { error?: string } | undefined) ??
        (data as { error?: string })
      throw new Error(inner?.error ?? 'Save failed.')
    }
    if (result.type === 'error') {
      throw new Error(result.error?.message ?? 'Save failed.')
    }
    throw new Error('Save failed.')
  }

  async function commitEdit() {
    if (!item || !editingField || !onSave) return
    editBusy = true
    editError = null
    try {
      if (editingField === 'expiry_date') {
        const trimmed = editDraft.trim()
        await postForm('?/updateExpiry', {
          item_id: item.id,
          expiry_date: trimmed,
        })
        await onSave({
          kind: 'expiry',
          itemId: item.id,
          expiry_date: trimmed === '' ? null : trimmed,
        })
      } else {
        await postForm('?/updateProduct', {
          item_id: item.id,
          field: editingField,
          value: editDraft,
        })
        const patch: ItemEditPatch = {
          kind: 'product',
          itemId: item.id,
          barcode: item.barcode,
        }
        if (editingField === 'product_name') {
          patch.product_name = editDraft.trim()
        } else if (editingField === 'full_weight_g') {
          patch.full_weight_g = Math.round(parseFloat(editDraft))
        } else if (editingField === 'tare_weight_g') {
          const trimmed = editDraft.trim()
          patch.tare_weight_g = trimmed === '' ? null : Math.round(parseFloat(trimmed))
        }
        await onSave(patch)
      }
      editingField = null
    } catch (e) {
      editError = e instanceof Error ? e.message : 'Save failed.'
    } finally {
      editBusy = false
    }
  }

  function handleEditKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    } else if (e.key === 'Enter' && editingField !== null) {
      e.preventDefault()
      void commitEdit()
    }
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
          {#if editingField === 'product_name'}
            <div class="edit-row edit-row--title">
              <input
                bind:this={editInput}
                bind:value={editDraft}
                onkeydown={handleEditKey}
                disabled={editBusy}
                maxlength="120"
                class="edit-input edit-input--title"
                aria-label="Product name"
              />
              <div class="edit-actions">
                <button type="button" class="edit-btn edit-btn--cancel" onclick={cancelEdit} disabled={editBusy} aria-label="Cancel">✕</button>
                <button type="button" class="edit-btn edit-btn--save" onclick={commitEdit} disabled={editBusy} aria-label="Save">{editBusy ? '…' : '✓'}</button>
              </div>
            </div>
            {#if editError}<p class="edit-error" role="alert">{editError}</p>{/if}
          {:else}
            <h2 id="product-modal-title" class="modal-title">
              <span class="modal-title__text">{item.product_name ?? item.barcode}</span>
              {#if canEdit}
                <button type="button" class="edit-pencil" onclick={() => startEdit('product_name')} aria-label="Edit product name" title="Edit name">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
              {/if}
            </h2>
          {/if}
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

          <!-- Full weight (editable, shared across catalog) -->
          <div>
            <dt>Full weight</dt>
            <dd>
              {#if editingField === 'full_weight_g'}
                <div class="edit-row">
                  <input
                    bind:this={editInput}
                    bind:value={editDraft}
                    onkeydown={handleEditKey}
                    disabled={editBusy}
                    type="number"
                    inputmode="numeric"
                    min="1"
                    step="1"
                    placeholder="grams"
                    class="edit-input edit-input--num"
                    aria-label="Full weight in grams"
                  />
                  <span class="edit-unit">g</span>
                  <div class="edit-actions">
                    <button type="button" class="edit-btn edit-btn--cancel" onclick={cancelEdit} disabled={editBusy} aria-label="Cancel">✕</button>
                    <button type="button" class="edit-btn edit-btn--save" onclick={commitEdit} disabled={editBusy} aria-label="Save">{editBusy ? '…' : '✓'}</button>
                  </div>
                </div>
                <p class="edit-note">Shared across all shelves with this product.</p>
                {#if editError}<p class="edit-error" role="alert">{editError}</p>{/if}
              {:else}
                <span class="meta-value">
                  {formatWeight(item.full_weight_g) ?? 'Not set'}
                </span>
                {#if canEdit}
                  <button type="button" class="edit-pencil edit-pencil--inline" onclick={() => startEdit('full_weight_g')} aria-label="Edit full weight" title="Edit">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                {/if}
              {/if}
            </dd>
          </div>

          <!-- Tare weight (editable, shared, optional) -->
          <div>
            <dt>Tare weight <small class="meta-hint">(empty container)</small></dt>
            <dd>
              {#if editingField === 'tare_weight_g'}
                <div class="edit-row">
                  <input
                    bind:this={editInput}
                    bind:value={editDraft}
                    onkeydown={handleEditKey}
                    disabled={editBusy}
                    type="number"
                    inputmode="numeric"
                    min="0"
                    step="1"
                    placeholder="grams (optional)"
                    class="edit-input edit-input--num"
                    aria-label="Tare weight in grams"
                  />
                  <span class="edit-unit">g</span>
                  <div class="edit-actions">
                    <button type="button" class="edit-btn edit-btn--cancel" onclick={cancelEdit} disabled={editBusy} aria-label="Cancel">✕</button>
                    <button type="button" class="edit-btn edit-btn--save" onclick={commitEdit} disabled={editBusy} aria-label="Save">{editBusy ? '…' : '✓'}</button>
                  </div>
                </div>
                <p class="edit-note">Shared across all shelves. Leave blank to clear.</p>
                {#if editError}<p class="edit-error" role="alert">{editError}</p>{/if}
              {:else}
                <span class="meta-value">
                  {formatWeight(item.tare_weight_g) ?? 'Not set'}
                </span>
                {#if canEdit}
                  <button type="button" class="edit-pencil edit-pencil--inline" onclick={() => startEdit('tare_weight_g')} aria-label="Edit tare weight" title="Edit">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                {/if}
              {/if}
            </dd>
          </div>

          {#if formatWeight(item.current_weight_g)}
            <div>
              <dt>Current weight</dt>
              <dd>{formatWeight(item.current_weight_g)}</dd>
            </div>
          {/if}

          <!-- Expiry (editable, per-shelf-item) -->
          <div>
            <dt>Expires</dt>
            <dd>
              {#if editingField === 'expiry_date'}
                <div class="edit-row">
                  <input
                    bind:this={editInput}
                    bind:value={editDraft}
                    onkeydown={handleEditKey}
                    disabled={editBusy}
                    type="date"
                    class="edit-input edit-input--date"
                    aria-label="Expiry date"
                  />
                  <div class="edit-actions">
                    <button type="button" class="edit-btn edit-btn--cancel" onclick={cancelEdit} disabled={editBusy} aria-label="Cancel">✕</button>
                    <button type="button" class="edit-btn edit-btn--save" onclick={commitEdit} disabled={editBusy} aria-label="Save">{editBusy ? '…' : '✓'}</button>
                  </div>
                </div>
                <p class="edit-note">Leave blank to clear.</p>
                {#if editError}<p class="edit-error" role="alert">{editError}</p>{/if}
              {:else}
                <span class="meta-value">{formatExpiry(item.expiry_date)}</span>
                {#if canEdit}
                  <button type="button" class="edit-pencil edit-pencil--inline" onclick={() => startEdit('expiry_date')} aria-label="Edit expiry date" title="Edit">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                {/if}
              {/if}
            </dd>
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
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .meta-value {
    overflow-wrap: anywhere;
  }

  .meta-hint {
    font-size: 0.7rem;
    opacity: 0.7;
    margin-left: 0.2rem;
  }

  /* ── Inline edit affordances ─────────────────────────────────────────── */
  .edit-pencil {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    opacity: 0.45;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.15s ease, background 0.15s ease;
  }

  .edit-pencil:hover,
  .edit-pencil:focus-visible {
    opacity: 1;
    background: rgba(0, 0, 0, 0.06);
  }

  .edit-pencil--inline {
    width: 1.25rem;
    height: 1.25rem;
  }

  .modal-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .modal-title__text {
    flex: 1;
    min-width: 0;
  }

  .edit-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    flex-wrap: wrap;
  }

  .edit-row--title {
    margin-bottom: 0.2rem;
  }

  .edit-input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.55rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--background);
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .edit-input:focus {
    border-color: var(--matcha);
    box-shadow: 0 0 0 3px var(--matcha-soft);
  }

  .edit-input--title {
    font-size: 1rem;
    font-weight: 600;
  }

  .edit-input--num {
    max-width: 6.5rem;
  }

  .edit-input--date {
    max-width: 10rem;
  }

  .edit-unit {
    font-size: 0.85rem;
    opacity: 0.7;
  }

  .edit-actions {
    display: inline-flex;
    gap: 0.25rem;
    margin-left: auto;
  }

  .edit-btn {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .edit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .edit-btn--save {
    background: var(--matcha, #7a8b3f);
    color: white;
    border-color: transparent;
  }

  .edit-btn--save:hover:not(:disabled) {
    filter: brightness(0.95);
  }

  .edit-btn--cancel:hover:not(:disabled) {
    background: var(--background);
  }

  .edit-note {
    flex-basis: 100%;
    margin: 0.15rem 0 0;
    font-size: 0.7rem;
    opacity: 0.65;
    line-height: 1.3;
  }

  .edit-error {
    flex-basis: 100%;
    margin: 0.25rem 0 0;
    padding: 0.3rem 0.5rem;
    background: rgba(164, 0, 0, 0.08);
    border-left: 2px solid var(--error, #a40000);
    border-radius: var(--radius-xs, 4px);
    font-size: 0.78rem;
    color: var(--error, #a40000);
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
