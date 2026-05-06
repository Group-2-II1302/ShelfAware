<script lang="ts">
  import { enhance }   from '$app/forms'
  import { goto }      from '$app/navigation'
  import { page }      from '$app/stores'
  import BarcodeScanner from '$lib/components/BarcodeScanner.svelte'

  // ── URL context ─────────────────────────────────────────────────────────────
  // shelf_id and slot are mandatory. Without them we cannot write to shelf_items.
  // The parent flow (e.g. the shelf setup screen) is responsible for appending
  // these to the navigation URL: /scan/barcode?shelf_id=abc&slot=2
  const shelf_id    = $derived($page.url.searchParams.get('shelf_id') ?? '')
  const slot        = $derived($page.url.searchParams.get('slot')     ?? '')
  // scale_index is slot parsed as integer — validated server-side as well
  const scale_index = $derived(parseInt(slot, 10))
  /**
   * Truthy when the user entered the flow by tapping a filled slot to
   * replace its product. Forwarded to the OCR step via a hidden form
   * field so the server can swap the existing shelf_items row instead
   * of inserting a new one. Treated as a boolean — value '1' or '0'.
   */
  const replaceMode = $derived($page.url.searchParams.get('replace') === '1')

  // Guard: if either param is missing or slot is not a valid integer, surface
  // the error immediately rather than letting the user scan and then fail.
  const urlParamsValid = $derived(
    shelf_id.length > 0 && slot.length > 0 && !isNaN(scale_index) && scale_index >= 0
  )

  // ── Product state ────────────────────────────────────────────────────────────
  type ProductCatalogEntry = {
    barcode:         string
    product_name:    string
    brand:           string
    image_url:       string
    full_weight_g:   number
    /**
     * Free-form metadata from OpenFoodFacts (nutriments, ingredients, etc.).
     * Stored as JSON in product_catalog.nutrition_facts. Null when the
     * product wasn't found or when entered manually.
     */
    nutrition_facts: Record<string, unknown> | null
  }

  /**
   * OpenFoodFacts exposes weight in several fields, none of which are
   * reliably present on every product. Try them in order of reliability.
   */
  function extractWeightG(p: any): number {
    // Most reliable: numeric grams when OFF has parsed it themselves
    const productQuantity = parseFloat(p.product_quantity)
    if (!isNaN(productQuantity) && productQuantity > 0) return productQuantity

    // Fallback: parse the human-readable "quantity" string ("200 g", "1 kg")
    const q: string = p.quantity ?? ''
    const match = q.match(/([\d.]+)\s*(kg|g|ml|l)?/i)
    if (match) {
      const n = parseFloat(match[1])
      const unit = (match[2] || 'g').toLowerCase()
      if (!isNaN(n) && n > 0) {
        if (unit === 'kg' || unit === 'l') return n * 1000
        return n
      }
    }

    // Last resort: net_weight_value (often empty/inconsistent)
    const netWeight = parseFloat(p.net_weight_value)
    if (!isNaN(netWeight) && netWeight > 0) return netWeight

    return 0
  }

  /**
   * Pull the interesting nutritional & metadata fields off OpenFoodFacts'
   * response. We deliberately copy-and-pick rather than store the whole
   * `product` blob — OFF responses are huge and most fields are noise.
   */
  function extractNutritionFacts(p: any): Record<string, unknown> {
    return {
      nutriments:                p.nutriments              ?? null,
      ingredients_text:          p.ingredients_text        ?? null,
      allergens_tags:            p.allergens_tags          ?? null,
      labels_tags:               p.labels_tags             ?? null,
      categories_tags:           p.categories_tags         ?? null,
      nova_group:                p.nova_group              ?? null,
      nutriscore_grade:          p.nutriscore_grade        ?? null,
      ecoscore_grade:            p.ecoscore_grade          ?? null,
      serving_size:              p.serving_size            ?? null,
      quantity:                  p.quantity                ?? null,
      packaging_tags:            p.packaging_tags          ?? null,
      countries_tags:            p.countries_tags          ?? null,
    }
  }

  let foundProduct     = $state<ProductCatalogEntry | null>(null)
  let confirmedProduct = $state(false)
  let isFetching       = $state(false)
  let isSaving         = $state(false)
  let fetchError       = $state<string | null>(null)
  let saveError        = $state<string | null>(null)
  let formElement      = $state<HTMLFormElement | null>(null)

  /**
   * State for the "couldn't find this barcode" prompt step. We show it
   * after a scan returns no OpenFoodFacts hit (or the network failed)
   * and let the user decide whether to enter the data manually or
   * re-scan. Holds the scanned barcode string while we wait for input;
   * null when no prompt is active.
   */
  let unknownProductBarcode = $state<string | null>(null)
  let lookupNetworkError    = $state(false)
  /**
   * Diagnostic detail for the network-error branch — kept separate
   * from user-facing copy so we can show a small "(reason: ...)" hint
   * without polluting the main message. Empty when no extra info.
   */
  let lookupErrorDetail     = $state('')
  /**
   * When the user opts into manual entry from the "not found" prompt,
   * we stash the scanned barcode here so BarcodeScanner can pre-fill it.
   * Empty string means no pre-fill (default fresh state).
   */
  let manualEntryBarcode    = $state('')

  // ── Auto-submit ──────────────────────────────────────────────────────────────
  // Only trigger when foundProduct is set AND has a non-empty product_name.
  // This prevents the $effect from firing on partial manual data mid-entry,
  // since the manual form calls onManualSave only on explicit submit.
  $effect(() => {
    if (
      confirmedProduct &&
      foundProduct?.product_name &&
      foundProduct?.barcode &&
      !isFetching &&
      !isSaving
    ) {
      // Defer one tick to allow the hidden inputs to reflect the new state
      setTimeout(() => formElement?.requestSubmit(), 50)
    }
  })

  // ── Barcode scan handler ─────────────────────────────────────────────────────
  const handleScan = async (barcode: string) => {
    isFetching  = true
    fetchError  = null
    saveError   = null

    try {
      /*
        Direct client-side call to OpenFoodFacts. We previously routed
        this through a server-side proxy at /api/product/[barcode] in
        order to set a custom User-Agent (recommended by OFF for
        high-volume consumers), but the proxy was unreliable from the
        Cloudflare Pages deployment — OFF's edge appeared to block or
        rate-limit requests originating from worker IPs. Browsers can't
        override User-Agent anyway, so calling OFF directly here matches
        what the rest of the consumer-facing apps in their docs do.

        TODO: revisit a server-side proxy once we have caching/quotas
        in place — see https://openfoodfacts.github.io/openfoodfacts-server/api/
      */
      const res = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
      )

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(
          `Product lookup returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        )
      }

      const data = await res.json()

      if (data.status === 1) {
        const p = data.product
        foundProduct = {
          barcode:         data.code,
          product_name:    p.product_name    || 'Unknown',
          brand:           p.brands          || '',
          image_url:       p.image_front_url || '',
          full_weight_g:   extractWeightG(p),
          nutrition_facts: extractNutritionFacts(p),
        }
      } else {
        /*
          Product not in OpenFoodFacts. Surface a dedicated "not found"
          step so the user can decide between manual entry and re-scan;
          we no longer auto-drop them into the manual form.
        */
        unknownProductBarcode = barcode
        lookupNetworkError    = false
      }
    } catch (err) {
      console.error('OpenFoodFacts fetch error:', err)
      unknownProductBarcode = barcode
      lookupNetworkError    = true
      lookupErrorDetail     = err instanceof Error ? err.message : String(err)
    } finally {
      isFetching = false
    }
  }

  // ── Manual save handler ──────────────────────────────────────────────────────
  // Called by BarcodeScanner when the user explicitly submits the manual form.
  // At this point all required fields have been filled and validated in the UI.
  const handleManualSave = (manualData: Partial<ProductCatalogEntry>) => {
    saveError = null
    foundProduct = {
      barcode:         manualData.barcode         || '',
      product_name:    manualData.product_name    || '',
      brand:           manualData.brand           || '',
      image_url:       manualData.image_url       || '',
      full_weight_g:   manualData.full_weight_g   ?? 0,
      nutrition_facts: manualData.nutrition_facts ?? null,
    }
    // Manual entry is its own confirmation — submitting the form means
    // the user has already vetted the data — so skip the confirm step.
    confirmedProduct = true
  }

  // ── Confirmation handlers ────────────────────────────────────────────────────
  const confirmProduct = () => {
    confirmedProduct = true
  }

  const rescanProduct = () => {
    foundProduct          = null
    confirmedProduct      = false
    fetchError            = null
    saveError             = null
    unknownProductBarcode = null
    lookupNetworkError    = false
    lookupErrorDetail     = ''
    manualEntryBarcode    = ''
  }

  // ── "Product not found" prompt handlers ─────────────────────────────────────
  /**
   * User chose to enter the product details manually after the lookup
   * failed. Stash the scanned barcode so BarcodeScanner can pre-fill it,
   * then dismiss the prompt.
   */
  const startManualEntry = () => {
    if (unknownProductBarcode) {
      manualEntryBarcode = unknownProductBarcode
    }
    unknownProductBarcode = null
    lookupNetworkError    = false
    lookupErrorDetail     = ''
  }
</script>

<div class="scan-page">

  {#if !urlParamsValid}
    <div class="error-card">
      <p class="error-title">Invalid shelf configuration</p>
      <p class="error-body">
        This page requires <code>shelf_id</code> and <code>slot</code> URL parameters.
        Navigate here from the shelf setup screen.
      </p>
      <p class="error-detail">
        Current URL: <code>{$page.url.search || '(no params)'}</code>
      </p>
    </div>

  {:else if unknownProductBarcode && !isFetching}
    <!-- Lookup step result: scan succeeded but the barcode wasn't in
         OpenFoodFacts (or the network failed). Let the user choose how
         to proceed instead of dumping them into the manual form. -->
    <div class="page-header">
      <h1>Product Not Found</h1>
      <p class="slot-label">
        Shelf <strong>{shelf_id}</strong> / Slot <strong>{slot}</strong>
      </p>
    </div>

    <div class="confirm-card">
      <div class="confirm-card__body">
        <p class="confirm-card__product">
          {lookupNetworkError ? "Couldn't reach product catalog" : "We couldn't find this barcode"}
        </p>
        <p class="confirm-card__brand">
          {#if lookupNetworkError}
            Check your connection and try again, or enter the product details by hand.
          {:else}
            The barcode scanned successfully but isn't in OpenFoodFacts.
            You can add it manually now or try scanning again.
          {/if}
        </p>
        <dl class="confirm-card__meta">
          <div class="confirm-card__meta-row">
            <dt>Barcode</dt>
            <dd>{unknownProductBarcode}</dd>
          </div>
        </dl>
        {#if lookupNetworkError && lookupErrorDetail}
          <details class="error-detail-toggle">
            <summary>Technical details</summary>
            <pre class="error-detail-body">{lookupErrorDetail}</pre>
          </details>
        {/if}
      </div>

      <div class="confirm-card__actions">
        <button type="button" class="btn-secondary" onclick={rescanProduct}>
          Re-scan
        </button>
        <button type="button" class="btn-primary" onclick={startManualEntry}>
          Enter manually
        </button>
      </div>
    </div>

  {:else if !foundProduct?.product_name && !isFetching}
    <div class="page-header">
      <h1>{replaceMode ? 'Replace Product' : 'Register Product'}</h1>
      <p class="slot-label">
        Shelf <strong>{shelf_id}</strong> / Slot <strong>{slot}</strong>
      </p>
      {#if replaceMode}
        <p class="replace-hint">
          Scanning will replace whatever is currently in this slot.
        </p>
      {/if}
    </div>

    {#if fetchError}
      <div class="notice-card">{fetchError}</div>
    {/if}

    <BarcodeScanner
      onscan={handleScan}
      onManualSave={handleManualSave}
      initialMode={manualEntryBarcode ? 'manual' : 'scan'}
      prefilledBarcode={manualEntryBarcode}
    />

  {:else if foundProduct?.product_name && !confirmedProduct && !isSaving && !saveError}
    <!-- Confirmation step: show what we found from OpenFoodFacts and let
         the user confirm or rescan before we commit anything. -->
    <div class="page-header">
      <h1>{replaceMode ? 'Confirm Replacement' : 'Confirm Product'}</h1>
      <p class="slot-label">
        Shelf <strong>{shelf_id}</strong> / Slot <strong>{slot}</strong>
      </p>
    </div>

    <div class="confirm-card">
      {#if foundProduct.image_url}
        <img
          class="confirm-card__image"
          src={foundProduct.image_url}
          alt={foundProduct.product_name}
        />
      {/if}

      <div class="confirm-card__body">
        <p class="confirm-card__product">{foundProduct.product_name}</p>
        {#if foundProduct.brand}
          <p class="confirm-card__brand">{foundProduct.brand}</p>
        {/if}
        <dl class="confirm-card__meta">
          <div class="confirm-card__meta-row">
            <dt>Barcode</dt>
            <dd>{foundProduct.barcode}</dd>
          </div>
          <div class="confirm-card__meta-row">
            <dt>Full weight</dt>
            <dd>
              {foundProduct.full_weight_g > 0
                ? `${foundProduct.full_weight_g} g`
                : 'Unknown — slot will be uncalibrated'}
            </dd>
          </div>
        </dl>
      </div>

      <div class="confirm-card__actions">
        <button type="button" class="btn-secondary" onclick={rescanProduct}>
          Re-scan
        </button>
        <button type="button" class="btn-primary" onclick={confirmProduct}>
          Looks good — Continue
        </button>
      </div>
    </div>

  {:else}
    <div class="status-card">
      {#if isFetching}
        <p class="status-msg">Searching product catalog...</p>
      {:else if isSaving}
        <p class="status-msg">Saving to shelf...</p>
      {:else if saveError}
        <p class="error-title">Save failed</p>
        <p class="error-body">{saveError}</p>
        <button
          class="btn-retry"
          onclick={rescanProduct}
        >
          Try again
        </button>
      {:else}
        <p class="status-msg">Preparing...</p>
      {/if}
    </div>
  {/if}

  <form
    bind:this={formElement}
    method="POST"
    action="?/saveProduct"
    use:enhance={() => {
      isSaving  = true
      saveError = null

      return async ({ result, update }) => {
        // If the result is a redirect, let SvelteKit's built-in client router 
        // carry out the redirect to the OCR scanner automatically.
        if (result.type === 'redirect') {
          await update()
        } else if (result.type === 'failure') {
          isSaving = false
          saveError = (result.data as any)?.error ?? 'An unexpected error occurred.'
          // Reset foundProduct so the scanner reappears and the user can retry
          foundProduct = null
          confirmedProduct = false
        } else if (result.type === 'error') {
          isSaving = false
          saveError = result.error?.message ?? 'An unexpected database/server error occurred.'
          foundProduct = null
          confirmedProduct = false
        } else {
          // General fallback state update
          await update()
        }
      }
    }}
    style="display: none;"
  >
    <input type="hidden" name="shelf_id"     value={shelf_id} />
    <input type="hidden" name="scale_index"  value={scale_index} />
    <input type="hidden" name="replace"      value={replaceMode ? '1' : '0'} />

    <input type="hidden" name="barcode"         value={foundProduct?.barcode         ?? ''} />
    <input type="hidden" name="product_name"    value={foundProduct?.product_name    ?? ''} />
    <input type="hidden" name="brand"           value={foundProduct?.brand           ?? ''} />
    <input type="hidden" name="image_url"       value={foundProduct?.image_url       ?? ''} />
    <input type="hidden" name="full_weight_g"   value={foundProduct?.full_weight_g   ?? 0}  />
    <input
      type="hidden"
      name="nutrition_facts"
      value={foundProduct?.nutrition_facts ? JSON.stringify(foundProduct.nutrition_facts) : ''}
    />
  </form>

</div>

<style>
  .scan-page {
    max-width: 500px;
    margin: auto;
    padding: 1rem;
  }

  .page-header {
    margin-bottom: 1rem;
  }

  .page-header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.4rem;
  }

  .slot-label {
    margin: 0;
    font-size: 0.85rem;
    color: #71717a;
  }

  .replace-hint {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    color: #b45309;
    background: #fef3c7;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
  }

  /* ── Status card ─────────────────────────────────────────────────────────── */
  .status-card {
    text-align: center;
    padding: 3rem 1rem;
  }

  .status-msg {
    color: #52525b;
    font-size: 1rem;
  }

  /* ── Error / notice cards ────────────────────────────────────────────────── */
  .error-card {
    padding: 1.5rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 10px;
    margin-bottom: 1rem;
  }

  .error-title {
    font-weight: 600;
    color: #dc2626;
    margin: 0 0 0.5rem;
  }

  .error-body {
    color: #7f1d1d;
    font-size: 0.9rem;
    margin: 0 0 0.5rem;
  }

  .error-detail {
    font-size: 0.8rem;
    color: #991b1b;
    margin: 0;
  }

  .notice-card {
    padding: 0.75rem 1rem;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 8px;
    color: #92400e;
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
  }

  .btn-retry {
    margin-top: 1rem;
    padding: 10px 24px;
    background: #6366f1;
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
  }

  /* ── Confirmation card ───────────────────────────────────────────────────── */
  .confirm-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .confirm-card__image {
    width: 100%;
    max-height: 220px;
    object-fit: contain;
    border-radius: 8px;
    background: #f4f4f5;
  }

  .confirm-card__body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .confirm-card__product {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .confirm-card__brand {
    margin: 0;
    font-size: 0.9rem;
    opacity: 0.75;
  }

  .confirm-card__meta {
    margin: 0.5rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.85rem;
  }

  .confirm-card__meta-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .confirm-card__meta-row dt {
    opacity: 0.7;
  }

  .error-detail-toggle {
    margin-top: 0.75rem;
    font-size: 0.8rem;
    opacity: 0.75;
  }

  .error-detail-toggle summary {
    cursor: pointer;
  }

  .error-detail-body {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.6rem;
    background: rgba(0, 0, 0, 0.05);
    border-radius: 0.4rem;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .confirm-card__meta-row dd {
    margin: 0;
    text-align: right;
  }

  .confirm-card__actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .confirm-card__actions .btn-primary,
  .confirm-card__actions .btn-secondary {
    flex: 1;
    padding: 0.65rem 0.75rem;
    border-radius: 8px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .confirm-card__actions .btn-primary {
    background: var(--accent);
    color: var(--accent-contrast);
    border: 1px solid var(--accent);
  }

  .confirm-card__actions .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }

  .btn-retry:hover {
    background: #4f46e5;
  }

  code {
    font-family: monospace;
    background: #f4f4f5;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.85em;
  }
</style>