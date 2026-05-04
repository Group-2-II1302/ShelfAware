<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Html5Qrcode } from 'html5-qrcode';

  export interface ScannerProps {
    onscan: (barcode: string) => void | Promise<void>;
    onManualSave: (data: any) => void;
  }

  let { onscan, onManualSave }: ScannerProps = $props();  
  let scanner: Html5Qrcode | null = null;
  let readerElement = $state<HTMLElement | undefined>(undefined);

  let isStarted = $state(false);
  let isInitializing = $state(false);
  let stopping = $state(false);
  let handled = $state(false);
  let errorMessage = $state<string | null>(null);
  let mode = $state<'scan' | 'manual'>('scan');

  let formData = $state({
    barcode: '',
    product_name: '',
    brand: '',
    image_url: '',
    full_weight_g: 0
  });

  async function startScanner() {
    if (isStarted || isInitializing || stopping) return;
    isInitializing = true;
    errorMessage = null;
    handled = false;
    try {
      if (!scanner && readerElement) {
        scanner = new Html5Qrcode(readerElement.id || 'reader-element');
      }
      if (scanner) {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.777778 },
          onScanSuccess,
          onScanFailure,
        );
        isStarted = true;
      }
    } catch (err: any) {
      isStarted = false;
    } finally {
      isInitializing = false;
    }
  }

  async function stopScanner() {
    if (!scanner || !isStarted || stopping) return;
    stopping = true;
    try {
      isStarted = false;
      await scanner.stop();
      await scanner.clear();
    } catch (err) {
      console.warn('Cleanup error:', err);
    } finally {
      stopping = false;
    }
  }

  async function onScanSuccess(decodedText: string) {
    if (handled) return;
    handled = true;
    await stopScanner();
    onscan(decodedText);
  }

  function onScanFailure() { }

  async function handleManualSubmit(e: Event) {
    e.preventDefault();
    onManualSave({ ...formData }); 
  }

  onMount(() => {
    if (readerElement && !scanner) {
      scanner = new Html5Qrcode(readerElement.id);
    }
  });

  onDestroy(async () => {
    await stopScanner();
  });
</script>

<div class="scanner-container">
  <div 
    id="reader-element" 
    bind:this={readerElement} 
    class="reader"
    class:hidden={mode === 'manual'}
  ></div>

  {#if mode === 'scan'}
    {#if !isStarted}
      <div class="overlay">
        <div class="button-group">
          <button onclick={startScanner} disabled={isInitializing} class="btn-primary">
            {isInitializing ? 'Initialising...' : 'Start Scanner'}
          </button>
          <button onclick={() => mode = 'manual'} class="btn-secondary">Enter Manually</button>
        </div>
      </div>
    {:else}
       <button onclick={() => mode = 'manual'} class="btn-floating">Manual Entry</button>
    {/if}
  {:else}
    <div class="manual-view">
      <form onsubmit={handleManualSubmit} class="manual-form">
        <h3>Manual Entry</h3>
        <div class="field">
          <label for="barcode">Barcode</label>
          <input id="barcode" type="text" bind:value={formData.barcode} required />
        </div>
        <div class="field">
          <label for="product_name">Product Name</label>
          <input id="product_name" type="text" bind:value={formData.product_name} required />
        </div>
        <div class="field">
          <label for="brand">Brand</label>
          <input id="brand" type="text" bind:value={formData.brand} />
        </div>
        <div class="field">
          <label for="weight">Weight (g)</label>
          <input id="weight" type="number" bind:value={formData.full_weight_g} />
        </div>
        <div class="form-actions">
          <button type="button" onclick={() => mode = 'scan'} class="btn-secondary">Back</button>
          <button type="submit" class="btn-primary">Save Product</button>
        </div>
      </form>
    </div>
  {/if}
</div>

<style>
  .scanner-container {
    position: relative; width: 100%; max-width: 500px; aspect-ratio: 16/9;
    margin: auto; background: #0a0a0a; border-radius: 12px; overflow: hidden; color: white;
  }
  .reader { width: 100%; height: 100%; }
  .reader.hidden { display: none; }
  .scanner-container :global(video) { width: 100% !important; height: 100% !important; object-fit: cover !important; }
  .overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column; 
    align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.85); padding: 20px; z-index: 10;
  }
  .manual-view { position: absolute; inset: 0; background: #1a1a1a; overflow-y: auto; padding: 20px; z-index: 20; }
  .manual-form { display: flex; flex-direction: column; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 4px; text-align: left; }
  .field label { font-size: 0.8rem; color: #a1a1aa; }
  .field input { padding: 8px; border-radius: 6px; border: 1px solid #3f3f46; background: #09090b; color: white; }
  .button-group { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 250px; }
  .form-actions { display: flex; gap: 10px; padding-top: 10px; }
  .btn-primary { background: #6366f1; color: white; border: none; padding: 10px; border-radius: 8px; font-weight: bold; cursor: pointer; flex: 1; }
  .btn-secondary { background: #3f3f46; color: white; border: none; padding: 10px; border-radius: 8px; font-weight: bold; cursor: pointer; flex: 1; }
  .btn-floating { position: absolute; bottom: 10px; right: 10px; background: rgba(99, 102, 241, 0.8); color: white; border: none; padding: 8px; border-radius: 8px; font-size: 0.75rem; z-index: 15; cursor: pointer; }
</style>