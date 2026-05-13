<script lang="ts">
  import { page } from '$app/state'
  import { enhance } from '$app/forms'
  import { goto } from '$app/navigation'
  import OcrScanner from '$lib/components/OcrScanner.svelte'
  import { IconCircleCheckFilled } from '@tabler/icons-svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  // 1. Recover URL parameters passed from the barcode scanner step
  const shelf_id    = $derived(page.url.searchParams.get('shelf_id') ?? '')
  const slot        = $derived(page.url.searchParams.get('slot')     ?? '')
  const barcode     = $derived(page.url.searchParams.get('barcode')  ?? '')
  /**
   * Truthy when the parent flow flagged this OCR step as a slot
   * replacement. Forwarded verbatim to the saveExpiry action so the
   * server can swap the existing shelf_items row instead of inserting.
   */
  const replaceMode = $derived(page.url.searchParams.get('replace')  === '1')

  const urlParamsValid = $derived(
    shelf_id.length > 0 && slot.length > 0 && barcode.length > 0,
  )

  // 2. Reactive flow states
  let scannedDate = $state('')
  let isSaving    = $state(false)
  let saveError   = $state<string | null>(null)
  let saveSuccess = $state(false)
  let formElement = $state<HTMLFormElement | null>(null)

  // 3. Handle when OcrScanner detects or confirms a date
  const handleDateFound = (date: string) => {
    scannedDate = date
    saveError = null

    // Allow state to bind to inputs, then submit the form automatically
    setTimeout(() => {
      if (formElement) {
        formElement.requestSubmit()
      }
    }, 50)
  }
</script>

<svelte:head>
  <title>Scan expiry · ShelfAware</title>
</svelte:head>

<div class="ocr-page">
  <div class="ocr-page__top">
    <a class="ocr-page__back" href="/" aria-label="Back to dashboard">←</a>
  </div>

  {#if !urlParamsValid}
    <div class="error-card">
      <p class="error-title">Missing scanning context</p>
      <p class="error-body">
        The scanner requires a valid shelf, slot, and product. Please start
        scanning from your dashboard.
      </p>
    </div>
  {:else if saveSuccess}
    <div class="success-card">
      <div class="success-card__icon">
        <IconCircleCheckFilled size={48} />
      </div>
      <h2 class="success-card__title">Expiry saved</h2>
      <p class="success-card__body">
        Taking you back to your shelf view…
      </p>
    </div>
  {:else}
    <div class="page-header">
      <h1>{replaceMode ? 'Scan new expiry date' : 'Scan expiry date'}</h1>
      <p class="context-label">
        <strong>{data.productName ?? barcode}</strong>
        <span class="context-label__sep">·</span>
        <span class="context-label__shelf">{data.shelfName ?? 'Unknown shelf'}</span>
        <span class="context-label__sep">·</span>
        Slot {slot}
      </p>
      <p class="scan-hint">
        Line up the expiry date inside the green box, then tap
        <strong>Scan</strong>. Can't read it automatically? You'll get the
        option to type it in.
      </p>
    </div>

    {#if saveError}
      <div class="error-card">
        <p class="error-title">Save failed</p>
        <p class="error-body">{saveError}</p>
        <button
          type="button"
          class="btn-retry"
          onclick={() => {
            saveError = null
            scannedDate = ''
          }}
        >
          Try again
        </button>
      </div>
    {/if}

    {#if isSaving}
      <div class="status-card">
        <p class="status-msg">Saving expiry dates to database…</p>
      </div>
    {:else}
      <OcrScanner onDateFound={handleDateFound} />
    {/if}
  {/if}

  <form
    bind:this={formElement}
    method="POST"
    action="?/saveExpiry"
    use:enhance={({ formData }) => {
      isSaving = true
      saveError = null

      // EXTREMELY CRITICAL: Force set the form fields to guarantee
      // the server never receives empty values due to delayed Svelte bindings
      formData.set('expiry_date', scannedDate)
      formData.set('barcode', barcode)
      formData.set('shelf_id', shelf_id)
      formData.set('scale_index', slot)
      formData.set('replace', replaceMode ? '1' : '0')

      return async ({ result }) => {
        isSaving = false

        if (result.type === 'success') {
          saveSuccess = true
          setTimeout(() => goto('/'), 1500)
        } else if (result.type === 'failure') {
          saveError =
            (result.data as any)?.error ?? 'An unexpected validation error occurred.'
          scannedDate = ''
        } else {
          saveError = 'Server failed to process requests.'
          scannedDate = ''
        }
      }
    }}
    style="display: none;"
  >
    <input type="hidden" name="expiry_date" value={scannedDate} />
    <input type="hidden" name="barcode" value={barcode} />
    <input type="hidden" name="shelf_id" value={shelf_id} />
    <input type="hidden" name="scale_index" value={slot} />
    <input type="hidden" name="replace" value={replaceMode ? '1' : '0'} />
  </form>
</div>

<style>
  .ocr-page {
    max-width: 500px;
    margin: 0 auto;
    padding: 1.25rem 1rem 5rem;
  }

  .ocr-page__top {
    display: flex;
    align-items: center;
    margin-bottom: 1rem;
  }

  .ocr-page__back {
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

  .ocr-page__back:hover {
    background: var(--background);
  }

  .page-header {
    margin-bottom: 1rem;
  }

  .page-header h1 {
    margin: 0 0 0.3rem;
    font-size: 1.4rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .context-label {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text);
    opacity: 0.7;
    line-height: 1.35;
  }

  .context-label strong {
    font-weight: 600;
    opacity: 1;
  }

  .context-label__sep {
    margin: 0 0.4rem;
    opacity: 0.5;
  }

  .context-label__shelf {
    font-weight: 500;
  }

  .scan-hint {
    margin: 0.6rem 0 0;
    font-size: 0.85rem;
    color: var(--text);
    opacity: 0.75;
    line-height: 1.4;
  }

  .scan-hint strong {
    font-weight: 600;
    opacity: 1;
  }

  .error-card {
    padding: 1.25rem;
    background: #fbecec;
    border-left: 3px solid var(--error);
    border-radius: var(--radius-md);
    margin-bottom: 1rem;
  }

  .error-title {
    font-weight: 600;
    color: var(--error);
    margin: 0 0 0.4rem;
  }

  .error-body {
    color: var(--text);
    font-size: 0.9rem;
    margin: 0 0 0.4rem;
    line-height: 1.4;
  }

  .btn-retry {
    margin-top: 0.6rem;
    padding: 0.6rem 1.2rem;
    background: var(--text);
    color: var(--background);
    border: none;
    border-radius: var(--radius-pill);
    font: inherit;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .btn-retry:hover {
    background: #1f1916;
  }

  .btn-retry:active {
    transform: translateY(1px);
  }

  .success-card {
    background: var(--surface);
    border-radius: var(--radius-lg);
    padding: 2.5rem 1.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    box-shadow: 0 1px 2px rgba(51, 42, 38, 0.04);
  }

  .success-card__icon {
    color: var(--matcha);
    margin-bottom: 0.25rem;
  }

  .success-card__icon :global(svg) {
    color: var(--matcha);
  }

  .success-card__title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .success-card__body {
    margin: 0;
    font-size: 0.92rem;
    opacity: 0.7;
  }

  .status-card {
    text-align: center;
    padding: 3rem 1rem;
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: 0 1px 2px rgba(51, 42, 38, 0.04);
  }

  .status-msg {
    color: var(--text);
    opacity: 0.7;
    font-size: 0.95rem;
    margin: 0;
  }
</style>
