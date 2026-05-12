<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Html5Qrcode } from 'html5-qrcode';

  export interface ScannerProps {
    onscan: (barcode: string) => void | Promise<void>;
    onManualSave: (data: any) => void;
    initialMode?: 'scan' | 'manual';
    prefilledBarcode?: string;
  }

  let {
    onscan,
    onManualSave,
    initialMode = 'scan',
    prefilledBarcode = '',
  }: ScannerProps = $props();

  let scanner: Html5Qrcode | null = null;
  let readerElement = $state<HTMLElement | undefined>(undefined);

  let isStarted = $state(false);
  let isInitializing = $state(false);
  let stopping = $state(false);
  let handled = $state(false);
  let scanSucceeded = $state(false);
  let errorMessage = $state<string | null>(null);

  // Mutable UI state
  let mode = $state<'scan' | 'manual'>('scan');

  let formData = $state({
    barcode: '',
    product_name: '',
    brand: '',
    image_url: '',
    full_weight_g: 0
  });

  // Keep state synced with prop updates
  $effect(() => {
    mode = initialMode;
  });

  $effect(() => {
    formData.barcode = prefilledBarcode;
  });

  const scanConfig = {
    fps: 25,
    qrbox: { width: 250, height: 150 },
    aspectRatio: 1.777778,
  };

  async function startScanner() {
    if (isStarted || isInitializing || stopping) return;

    isInitializing = true;
    errorMessage = null;
    handled = false;

    try {
      if (!scanner && readerElement) {
        scanner = new Html5Qrcode(readerElement.id);
      }

      if (!scanner) return;

      const tried = await tryStartBarcodeScanner(scanner);
      if (!tried.ok) {
        errorMessage =
          tried.message ??
          'Could not start the camera. Allow camera access in system settings and try again.';
        return;
      }

      isStarted = true;
    } finally {
      isInitializing = false;
    }
  }

  /** Prefer enumerated cameras (reliable in Capacitor WebView); fall back to facingMode. */
  async function tryStartBarcodeScanner(qr: Html5Qrcode): Promise<{ ok: true } | { ok: false; message?: string }> {
    try {
      const devices = await Html5Qrcode.getCameras();
      const preferred =
        devices.find((d) => /back|rear|environment/i.test(d.label)) ?? devices[0];

      if (preferred) {
        await qr.start(preferred.id, scanConfig, onScanSuccess, onScanFailure);
        return { ok: true };
      }
    } catch {
      /* fall through */
    }

    const fallbacks: MediaTrackConstraints[] = [
      { facingMode: 'environment' },
      { facingMode: 'user' },
      {},
    ];

    let lastMessage: string | undefined;

    for (const cam of fallbacks) {
      try {
        await qr.start(cam, scanConfig, onScanSuccess, onScanFailure);
        return { ok: true };
      } catch (e) {
        lastMessage = e instanceof Error ? e.message : String(e);
        try {
          await qr.stop();
          await qr.clear();
        } catch {
          /* ignore */
        }
      }
    }

    return { ok: false, message: lastMessage };
  }

  async function stopScanner() {
    if (!scanner || !isStarted || stopping) return;

    stopping = true;

    try {
      isStarted = false;
      await scanner.stop();
      await scanner.clear();
    } finally {
      stopping = false;
      scanSucceeded = false;
    }
  }

  async function onScanSuccess(decodedText: string) {
    if (handled) return;

    handled = true;
    scanSucceeded = true;

    await new Promise((r) => setTimeout(r, 450));

    await stopScanner();

    await onscan(decodedText);
  }

  function onScanFailure() {}

  function handleManualSubmit(e: Event) {
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

  {#if scanSucceeded}
    <div class="success-overlay" aria-live="polite">
      <div class="success-box">
        <svg
          class="success-check"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="4 12 10 18 20 6" />
        </svg>
      </div>
    </div>
  {/if}

  {#if mode === 'scan'}
    {#if !isStarted}
      <div class="overlay">
        {#if errorMessage}
          <p class="error-banner" role="alert">{errorMessage}</p>
        {/if}
        <div class="button-group">
          <button onclick={startScanner} disabled={isInitializing} class="btn-primary">
            {isInitializing ? 'Initialising…' : 'Start scanner'}
          </button>
          <button onclick={() => (mode = 'manual')} class="btn-secondary">
            Enter manually
          </button>
        </div>
      </div>
    {:else}
       <button onclick={() => (mode = 'manual')} class="btn-floating">
         Manual entry
       </button>
    {/if}
  {:else}
    <div class="manual-view">
      <form onsubmit={handleManualSubmit} class="manual-form">
        <h3 class="manual-form__title">Enter product details</h3>
        <div class="field">
          <label for="barcode">Barcode</label>
          <input id="barcode" type="text" bind:value={formData.barcode} required />
        </div>
        <div class="field">
          <label for="product_name">Product name</label>
          <input
            id="product_name"
            type="text"
            bind:value={formData.product_name}
            required
          />
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
          <button
            type="button"
            onclick={() => (mode = 'scan')}
            class="btn-secondary"
          >
            Back
          </button>
          <button type="submit" class="btn-primary">Save product</button>
        </div>
      </form>
    </div>
  {/if}
</div>

<style>
  .scanner-container {
    position: relative;
    width: 100%;
    max-width: 500px;
    aspect-ratio: 16 / 9;
    margin: 0 auto;
    background: #0a0a0a;
    border-radius: var(--radius-lg);
    overflow: hidden;
    color: #fff;
  }

  .reader {
    width: 100%;
    height: 100%;
  }
  .reader.hidden {
    display: none;
  }

  .scanner-container :global(video) {
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(20, 16, 14, 0.82);
    padding: 1.25rem;
    z-index: 10;
  }

  .error-banner {
    margin: 0 0 0.9rem;
    padding: 0.55rem 0.85rem;
    max-width: 18rem;
    text-align: center;
    font-size: 0.85rem;
    line-height: 1.4;
    color: #fff;
    background: rgba(164, 0, 0, 0.55);
    border-left: 3px solid var(--error);
    border-radius: var(--radius-sm);
  }

  /*
    Manual entry view: a creamy panel sitting over the camera. Uses
    the app's matcha/brown palette so it doesn't feel like a separate
    app dropped into the scanner.
  */
  .manual-view {
    position: absolute;
    inset: 0;
    background: var(--surface);
    color: var(--text);
    overflow-y: auto;
    padding: 1.1rem;
    z-index: 20;
  }

  .manual-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .manual-form__title {
    margin: 0 0 0.25rem;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    text-align: left;
  }

  .field label {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text);
    opacity: 0.7;
  }

  .field input {
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--background);
    color: var(--text);
    font: inherit;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .field input:focus {
    border-color: var(--matcha);
    background: var(--surface);
    box-shadow: 0 0 0 3px var(--matcha-soft);
  }

  .button-group {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: 100%;
    max-width: 16rem;
  }

  .form-actions {
    display: flex;
    gap: 0.6rem;
    padding-top: 0.5rem;
  }

  /*
    Pill buttons matching the app-wide pattern. We use surface/border
    inside the cream manual view, but on the dark overlay we need the
    secondary to remain legible — handled with a more contrast-aware
    `.overlay .btn-secondary` rule below.
  */
  .btn-primary {
    flex: 1;
    background: var(--text);
    color: var(--background);
    border: none;
    padding: 0.7rem 1rem;
    border-radius: var(--radius-pill);
    font: inherit;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.05s ease, opacity 0.15s ease;
  }

  .btn-primary:hover:not(:disabled) {
    background: #1f1916;
  }

  .btn-primary:active:not(:disabled) {
    transform: translateY(1px);
  }

  .btn-primary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    flex: 1;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 0.7rem 1rem;
    border-radius: var(--radius-pill);
    font: inherit;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .btn-secondary:hover {
    background: var(--background);
  }

  .btn-secondary:active {
    transform: translateY(1px);
  }

  /*
    Secondary button when sitting on the dark camera overlay — solid
    surface fill is fine here too because it provides good contrast
    against the near-black backdrop; only the border looks wrong, so
    we soften it.
  */
  .overlay .btn-secondary {
    border-color: transparent;
  }

  /*
    Floating "Manual entry" button that sits inside the live camera
    view. Translucent matcha so it reads as a hint affordance rather
    than the primary action.
  */
  .btn-floating {
    position: absolute;
    bottom: 0.6rem;
    right: 0.6rem;
    background: rgba(122, 139, 63, 0.85);
    color: #fff;
    border: none;
    padding: 0.45rem 0.85rem;
    border-radius: var(--radius-pill);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    z-index: 15;
    cursor: pointer;
    backdrop-filter: blur(4px);
    transition: background 0.15s ease;
  }

  .btn-floating:hover {
    background: var(--matcha-deep);
  }

  /* ── Scan-success feedback ──────────────────────────────────────────── */
  .success-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(122, 139, 63, 0.18);
    z-index: 25;
    animation: success-flash 0.45s ease-out;
  }

  .success-box {
    width: 250px;
    height: 150px;
    border: 3px solid var(--matcha);
    border-radius: var(--radius-sm);
    box-shadow: 0 0 0 2px rgba(122, 139, 63, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(122, 139, 63, 0.1);
  }

  .success-check {
    width: 64px;
    height: 64px;
    color: var(--matcha);
    animation: success-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  @keyframes success-flash {
    0% {
      background: rgba(122, 139, 63, 0);
    }
    30% {
      background: rgba(122, 139, 63, 0.28);
    }
    100% {
      background: rgba(122, 139, 63, 0.18);
    }
  }

  @keyframes success-pop {
    0% {
      transform: scale(0.4);
      opacity: 0;
    }
    60% {
      transform: scale(1.15);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
</style>