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

  // Guard: if either param is missing or slot is not a valid integer, surface
  // the error immediately rather than letting the user scan and then fail.
  const urlParamsValid = $derived(
    shelf_id.length > 0 && slot.length > 0 && !isNaN(scale_index) && scale_index >= 0
  )

  // ── Product state ────────────────────────────────────────────────────────────
  type ProductCatalogEntry = {
    barcode:      string
    product_name: string
    brand:        string
    image_url:    string
    full_weight_g: number
  }

  let foundProduct = $state<ProductCatalogEntry | null>(null)
  let isFetching   = $state(false)
  let isSaving     = $state(false)
  let fetchError   = $state<string | null>(null)
  let saveError    = $state<string | null>(null)
  let formElement  = $state<HTMLFormElement | null>(null)

  // ── Auto-submit ──────────────────────────────────────────────────────────────
  // Only trigger when foundProduct is set AND has a non-empty product_name.
  // This prevents the $effect from firing on partial manual data mid-entry,
  // since the manual form calls onManualSave only on explicit submit.
  $effect(() => {
    if (
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
      const res = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
      )

      if (!res.ok) {
        throw new Error(`OpenFoodFacts returned ${res.status}`)
      }

      const data = await res.json()

      if (data.status === 1) {
        const p = data.product
        foundProduct = {
          barcode:       data.code,
          product_name:  p.product_name          || 'Unknown',
          brand:         p.brands                || '',
          image_url:     p.image_front_url       || '',
          // OpenFoodFacts net_weight_value is sometimes a string — coerce safely
          full_weight_g: parseFloat(p.net_weight_value) || 0,
        }
      } else {
        // Product not in OpenFoodFacts — pre-fill the barcode and let user
        // complete the rest via manual entry in BarcodeScanner
        fetchError = 'Product not found in catalog. Please enter details manually.'
        foundProduct = {
          barcode,
          product_name: '',
          brand:        '',
          image_url:    '',
          full_weight_g: 0,
        }
        // Do NOT set full foundProduct here — product_name is empty so the
        // $effect guard above will NOT auto-submit. The user must fill in
        // the manual form and submit it explicitly.
      }
    } catch (err) {
      console.error('OpenFoodFacts fetch error:', err)
      fetchError = 'Could not reach product catalog. Please enter details manually.'
      // Same pattern — empty product_name prevents auto-submit
      foundProduct = { barcode, product_name: '', brand: '', image_url: '', full_weight_g: 0 }
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
      barcode:       manualData.barcode      || '',
      product_name:  manualData.product_name || '',
      brand:         manualData.brand        || '',
      image_url:     manualData.image_url    || '',
      full_weight_g: manualData.full_weight_g ?? 0,
    }
    // product_name is now set — $effect will fire and submit the form
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

  {:else if !foundProduct?.product_name && !isFetching}
    <div class="page-header">
      <h1>Register Product</h1>
      <p class="slot-label">
        Shelf <strong>{shelf_id}</strong> / Slot <strong>{slot}</strong>
      </p>
    </div>

    {#if fetchError}
      <div class="notice-card">{fetchError}</div>
    {/if}

    <BarcodeScanner
      onscan={handleScan}
      onManualSave={handleManualSave}
    />

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
          onclick={() => { foundProduct = null; saveError = null; fetchError = null }}
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
        } else if (result.type === 'error') {
          isSaving = false
          saveError = result.error?.message ?? 'An unexpected database/server error occurred.'
          foundProduct = null
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

    <input type="hidden" name="barcode"       value={foundProduct?.barcode       ?? ''} />
    <input type="hidden" name="product_name"  value={foundProduct?.product_name  ?? ''} />
    <input type="hidden" name="brand"         value={foundProduct?.brand         ?? ''} />
    <input type="hidden" name="image_url"     value={foundProduct?.image_url     ?? ''} />
    <input type="hidden" name="full_weight_g" value={foundProduct?.full_weight_g ?? 0}  />
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