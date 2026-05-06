<script lang="ts">
  import { page } from '$app/stores';
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import OcrScanner from '$lib/components/OcrScanner.svelte'; // Make sure path points to your OCR component

  // 1. Recover URL parameters passed from the barcode scanner step
  const shelf_id    = $derived($page.url.searchParams.get('shelf_id') ?? '');
  const slot        = $derived($page.url.searchParams.get('slot')     ?? '');
  const barcode     = $derived($page.url.searchParams.get('barcode')  ?? '');
  /**
   * Truthy when the parent flow flagged this OCR step as a slot
   * replacement. Forwarded verbatim to the saveExpiry action so the
   * server can swap the existing shelf_items row instead of inserting.
   */
  const replaceMode = $derived($page.url.searchParams.get('replace')  === '1');

  const urlParamsValid = $derived(
    shelf_id.length > 0 && slot.length > 0 && barcode.length > 0
  );

  // 2. Reactive flow states
  let scannedDate = $state('');
  let isSaving    = $state(false);
  let saveError   = $state<string | null>(null);
  let saveSuccess = $state(false);
  let formElement = $state<HTMLFormElement | null>(null);

  // 3. Handle when OcrScanner detects or confirms a date
  const handleDateFound = (date: string) => {
    scannedDate = date;
    saveError = null;
    
    // Allow state to bind to inputs, then submit the form automatically
    setTimeout(() => {
      if (formElement) {
        formElement.requestSubmit();
      }
    }, 50);
  };
</script>

<div class="ocr-flow-page">
  {#if !urlParamsValid}
    <div class="error-card">
      <p class="error-title">Missing Scanning Context</p>
      <p class="error-body">
        The scanner requires valid shelf, slot, and barcode parameters. 
        Please start scanning from your dashboard.
      </p>
    </div>
  {:else if saveSuccess}
    <div class="success-card">
      <div class="success-icon">✓</div>
      <h2>Expiry Saved Successfully!</h2>
      <p>Redirecting you back to your shelf view...</p>
    </div>
  {:else}
    <div class="page-header">
      <h1>{replaceMode ? 'Scan New Expiry Date' : 'Scan Expiry Date'}</h1>
      <p class="context-label">
        Product: <code>{barcode}</code> | Slot: <code>{slot}</code>
      </p>
    </div>

    {#if saveError}
      <div class="error-card">
        <p class="error-title">Save Failed</p>
        <p class="error-body">{saveError}</p>
        <button class="btn-retry" onclick={() => { saveError = null; scannedDate = ''; }}>
          Try Again
        </button>
      </div>
    {/if}

    {#if isSaving}
      <div class="loading-overlay">
        <p class="status-msg">Saving expiry dates to database...</p>
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
      isSaving = true;
      saveError = null;

      // EXTREMELY CRITICAL: Force set the form fields to guarantee 
      // the server never receives empty values due to delayed Svelte bindings
      formData.set("expiry_date", scannedDate);
      formData.set("barcode", barcode);
      formData.set("shelf_id", shelf_id);
      formData.set("scale_index", slot);
      formData.set("replace", replaceMode ? '1' : '0');

      return async ({ result }) => {
        isSaving = false;
        
        if (result.type === 'success') {
          saveSuccess = true;
          // Smoothly redirect back to the home/shelves dashboard after 1.5 seconds
          setTimeout(() => {
            goto('/');
          }, 1500);
        } else if (result.type === 'failure') {
          saveError = (result.data as any)?.error ?? 'An unexpected validation error occurred.';
          scannedDate = '';
        } else {
          saveError = 'Server failed to process requests.';
          scannedDate = '';
        }
      };
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
  .ocr-flow-page {
    max-width: 500px;
    margin: auto;
    padding: 1rem;
  }
  .page-header {
    margin-bottom: 1.5rem;
    text-align: center;
  }
  .page-header h1 {
    font-size: 1.5rem;
    margin-bottom: 0.5rem;
  }
  .context-label {
    font-size: 0.85rem;
    color: #71717a;
    margin: 0;
  }
  .error-card {
    padding: 1.5rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 10px;
    text-align: center;
    margin-bottom: 1rem;
  }
  .error-title {
    font-weight: 600;
    color: #dc2626;
    margin-top: 0;
  }
  .error-body {
    color: #7f1d1d;
    font-size: 0.9rem;
  }
  .success-card {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 12px;
    padding: 3rem 1.5rem;
    text-align: center;
    color: #166534;
  }
  .success-icon {
    font-size: 3rem;
    color: #22c55e;
    margin-bottom: 1rem;
  }
  .loading-overlay {
    text-align: center;
    padding: 4rem 1rem;
  }
  .status-msg {
    color: #52525b;
  }
  .btn-retry {
    margin-top: 1rem;
    padding: 10px 20px;
    background: #6366f1;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  code {
    font-family: monospace;
    background: #f4f4f5;
    padding: 2px 4px;
    border-radius: 4px;
  }
</style>