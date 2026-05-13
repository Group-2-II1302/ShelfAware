<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { parseExpiryDate } from '$lib/utils/parseExpiryDate'

  export interface OcrProps {
    /** Called with "DD-MM-YYYY" once the user taps Confirm. */
    onDateFound: (date: string) => void
    /** When true, show developer-facing preview + raw OCR debug. Default false. */
    showDebug?: boolean
  }

  let { onDateFound, showDebug = false }: OcrProps = $props()

  // ===== DOM refs =====
  let videoElement = $state<HTMLVideoElement | null>(null)
  let canvasElement = $state<HTMLCanvasElement | null>(null)
  let previewCanvas = $state<HTMLCanvasElement | null>(null)

  // ===== Scan state =====
  let isStarted = $state(false)
  let isScanning = $state(false)
  let errorMessage = $state<string | null>(null)
  let lastRawText = $state<string>('')
  let stream = $state<MediaStream | null>(null)
  let foundDate = $state<string | null>(null)
  let editedDateIso = $state<string>('')  // bound to <input type="date">, format "YYYY-MM-DD"
  let editError = $state<string | null>(null)
  let failCount = $state(0)          // full scan cycles that found nothing
  let manualInput = $state('')
  let manualError = $state(false)

  // ===== Tunables =====
  const UPSCALE = 2
  // Crop area — same proportions as the green overlay box
  const CROP_W_RATIO = 0.7
  const CROP_H_RATIO = 0.25
  const CROP_Y_RATIO = 0.1

  // ===== Helpers =====
  /**
   * Convert obvious OCR misreads in tokens that should be numeric.
   */
  function fixDigitOnly(token: string): string {
    return token
      .replace(/[Oo]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/[zZ]/g, '2')
      .replace(/[gqG]/g, '9')
  }

  /**
   * Apply OCR digit-correction then delegate to the shared parseExpiryDate
   * utility. Returns "DD-MM-YYYY" or empty string.
   */
  function findDate(text: string): string {
    if (!text) return ''
    const corrected = fixDigitOnly(text)
    return parseExpiryDate(corrected) ?? ''
  }

  /*
    The detected date arrives as "DD-MM-YYYY" but <input type="date">
    only accepts ISO "YYYY-MM-DD". These tiny helpers shuttle between
    the two so the edit-in-place flow works without changing the
    onDateFound contract with the parent page.
  */
  function ddmmyyyyToIso(dmy: string): string {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dmy.trim())
    if (!match) return ''
    return `${match[3]}-${match[2]}-${match[1]}`
  }

  function isoToDdmmyyyy(iso: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
    if (!match) return ''
    return `${match[3]}-${match[2]}-${match[1]}`
  }

  // ===== Camera =====
  async function startCamera() {
    errorMessage = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
      if (videoElement) {
        videoElement.srcObject = stream
        videoElement.onloadedmetadata = () => (isStarted = true)
      }
    } catch (err) {
      errorMessage = 'Camera access denied.'
    }
  }

  // ===== Frame capture =====
  /**
   * Captures a cropped, lightly-processed frame from the video feed.
   * Returns a data URL (PNG) or null if the frame is not ready.
   *
   * Google Vision handles the heavy lifting — we only apply a mild
   * contrast + grayscale filter and crop to the scan ROI so the API
   * receives a clean, focused image.
   */
  function captureFrame(): string | null {
    if (!videoElement || !canvasElement) return null
    const ctx = canvasElement.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    const sw = videoElement.videoWidth
    const sh = videoElement.videoHeight
    if (!sw || !sh) return null

    // Crop to the green overlay box
    const cropW = Math.floor(sw * CROP_W_RATIO)
    const cropH = Math.floor(sh * CROP_H_RATIO)
    const cropX = Math.floor((sw - cropW) / 2)
    const cropY = Math.floor(sh * CROP_Y_RATIO)

    canvasElement.width  = cropW * UPSCALE
    canvasElement.height = cropH * UPSCALE

    // Mild contrast + grayscale — enough to sharpen ink on busy backgrounds
    // without losing detail that Vision's model relies on.
    ctx.filter = 'contrast(1.3) grayscale(1)'
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(
      videoElement,
      cropX, cropY, cropW, cropH,
      0, 0, canvasElement.width, canvasElement.height,
    )
    ctx.filter = 'none'

    // Mirror into the preview thumbnail so the user sees exactly what
    // gets sent to the API.
    if (previewCanvas) {
      const pctx = previewCanvas.getContext('2d')
      if (pctx) {
        previewCanvas.width  = canvasElement.width
        previewCanvas.height = canvasElement.height
        pctx.drawImage(canvasElement, 0, 0)
      }
    }

    return canvasElement.toDataURL('image/png')
  }

  // ===== Scan =====
  /**
   * Captures one frame, sends it to the Google Vision endpoint, then
   * tries to extract a date from the returned text.
   */
  async function scanText() {
    if (isScanning) return

    isScanning = true
    errorMessage = null
    lastRawText = ''
    foundDate = null

    try {
      const dataUrl = captureFrame()
      if (!dataUrl) {
        errorMessage = 'Could not capture frame — is the camera ready?'
        return
      }

      // Strip "data:image/png;base64," prefix
      const base64 = dataUrl.split(',')[1]

      const res = await fetch('/scan/ocr/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(`[${res.status}] ${body.message ?? 'Server error'}`)
      }

      const { text } = await res.json() as { text: string }
      lastRawText = text

      const date = findDate(text)
      if (date) {
        foundDate = date
        editedDateIso = ddmmyyyyToIso(date)
        editError = null
      } else {
        failCount += 1
        /*
          Manual input is always visible below now, so we don't need
          the "type what you see below" escalation copy. Keep a short
          single-line tip so the user has actionable feedback when
          auto-detect can't find a date.
        */
        errorMessage = 'No date found. Try better lighting, or type it below.'
      }
    } catch (err) {
      console.error('Vision OCR error:', err)
      failCount += 1
      errorMessage = `Scan failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      isScanning = false
    }
  }

  /** User typed a date manually — run it through the parser. */
  function tryManualDate() {
    if (!manualInput.trim()) return
    const parsed = parseExpiryDate(manualInput.trim())
    if (parsed) {
      manualError = false
      foundDate = parsed
      /*
        Also seed the editable result input so the day/month/year
        spinners on the result panel show the value the user just
        entered. Without this the result panel would render with an
        empty date input — matching the auto-scan path which sets
        both fields when it succeeds.
      */
      editedDateIso = ddmmyyyyToIso(parsed)
      editError = null
    } else {
      manualError = true
    }
  }

  /*
    Confirm the date currently in the editable field. Re-parse so a
    manual tweak still goes through the same calendar-validation as
    a fresh OCR result — guards against the user selecting Feb 30
    via spinner madness or pasting nonsense.
  */
  function confirmDate() {
    const dmy = isoToDdmmyyyy(editedDateIso)
    if (!dmy) {
      editError = 'Please pick a valid date.'
      return
    }
    const parsed = parseExpiryDate(dmy)
    if (!parsed) {
      editError = "That date doesn't look valid."
      return
    }
    editError = null
    onDateFound(parsed)
  }

  /** User rejected the detected date — clear it so they can re-scan. */
  function rescan() {
    foundDate = null
    editedDateIso = ''
    editError = null
    errorMessage = null
    manualInput = ''
    manualError = false
  }

  // ===== Lifecycle =====
  onMount(() => {
    startCamera()
  })

  onDestroy(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
    }
  })
</script>

<div class="ocr-container">
  <div class="video-wrapper">
    <video bind:this={videoElement} autoplay playsinline muted></video>
    {#if isStarted}
      <div class="scan-overlay" aria-hidden="true"></div>
      <div class="roi-caption" aria-hidden="true">
        Frame the expiry date inside the box
      </div>
    {/if}

    {#if !isStarted}
      <div class="controls-overlay">
        <button onclick={startCamera} class="main-btn">Start camera</button>
      </div>
    {/if}
  </div>

  <canvas bind:this={canvasElement} style="display: none;"></canvas>

  {#if isStarted}
    {#if foundDate}
      <div class="result-panel">
        <p class="result-label">Expiry date detected</p>
        <input
          class="result-date-input"
          class:result-date-input--error={editError}
          type="date"
          bind:value={editedDateIso}
          aria-label="Expiry date"
        />
        {#if editError}
          <p class="manual-error result-date-error">{editError}</p>
        {:else}
          <p class="result-edit-hint">Tap to edit if it's not quite right.</p>
        {/if}
        <div class="result-actions">
          <button onclick={rescan} class="btn-secondary">Re-scan</button>
          <button onclick={confirmDate} class="btn-confirm">Confirm</button>
        </div>
      </div>
    {:else}
      <div class="actions">
        <button onclick={scanText} disabled={isScanning} class="main-btn">
          {#if isScanning}
            Reading…
          {:else}
            Scan
          {/if}
        </button>
      </div>
    {/if}

    <!--
      Manual input — always visible while we don't yet have a date.
      Earlier this was gated behind SHOW_MANUAL_AFTER_FAIL retries,
      but users with hard-to-OCR labels were left tapping Scan with
      no obvious escape hatch. Showing it up-front is a better
      affordance; the auto-scan still takes precedence whenever it
      succeeds.
    -->
    {#if !foundDate}
      <div class="manual-panel">
        <p class="manual-hint">
          Can't read it automatically? Type what you see on the label — any
          format works (e.g. <code>06 02 27</code>, <code>060227</code>, <code>27/02/2027</code>).
        </p>
        <div class="manual-row">
          <input
            class="manual-input"
            class:manual-input--error={manualError}
            type="text"
            inputmode="numeric"
            placeholder="e.g. 06 02 27"
            bind:value={manualInput}
            onkeydown={(e) => e.key === 'Enter' && tryManualDate()}
          />
          <button class="btn-use" onclick={tryManualDate}>Use</button>
        </div>
        {#if manualError}
          <p class="manual-error">Couldn't recognise that — try DD MM YY or DD/MM/YYYY.</p>
        {/if}
      </div>
    {/if}

    {#if errorMessage}
      <p class="error-msg" role="status">{errorMessage}</p>
    {/if}

    {#if showDebug}
      <div class="preview-wrap">
        <p class="raw-label">Preview:</p>
        <canvas bind:this={previewCanvas} class="preview-canvas"></canvas>
      </div>

      <div class="debug-panel">
        {#if lastRawText}
          <p class="raw-label">Google Vision read:</p>
          <code class="raw-output">"{lastRawText}"</code>
        {/if}
      </div>
    {:else}
      <!-- Preview canvas still mounted (hidden) so captureFrame()
           can paint into it without null-checking — cleaner than
           rebuilding the capture pipeline conditionally. -->
      <canvas bind:this={previewCanvas} style="display: none;"></canvas>
    {/if}
  {/if}
</div>

<style>
  .ocr-container {
    width: 100%;
    max-width: 500px;
    margin: 0 auto;
  }

  .video-wrapper {
    position: relative;
    width: 100%;
    aspect-ratio: 16/9;
    background: #000;
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* ROI box. Coordinates mirror CROP_*_RATIO constants so the user
     frames the exact rectangle the capture pipeline crops. */
  .scan-overlay {
    position: absolute;
    left: 15%;
    top: 10%;
    width: 70%;
    height: 25%;
    border: 2px solid var(--matcha);
    border-radius: var(--radius-sm);
    pointer-events: none;
    box-shadow:
      0 0 0 9999px rgba(0, 0, 0, 0.55),
      0 0 12px rgba(122, 139, 63, 0.6);
  }

  .roi-caption {
    position: absolute;
    left: 50%;
    bottom: 0.75rem;
    transform: translateX(-50%);
    background: rgba(20, 16, 14, 0.6);
    color: #fff;
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-pill);
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.01em;
    pointer-events: none;
    backdrop-filter: blur(4px);
  }

  .controls-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
  }

  .actions {
    margin-top: 0.85rem;
  }

  .main-btn {
    width: 100%;
    padding: 0.85rem 1rem;
    background: var(--text);
    color: var(--background);
    border: none;
    border-radius: var(--radius-pill);
    font: inherit;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .main-btn:hover:not(:disabled) {
    background: #1f1916;
  }

  .main-btn:active:not(:disabled) {
    transform: translateY(1px);
  }

  .main-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* ── Result panel ─────────────────────────────────────────────────── */
  .result-panel {
    margin-top: 0.85rem;
    padding: 1.1rem 1.1rem 1rem;
    background: var(--matcha-soft);
    border-left: 3px solid var(--matcha);
    border-radius: var(--radius-md);
    text-align: center;
  }

  .result-label {
    margin: 0 0 0.25rem;
    font-size: 0.72rem;
    color: var(--matcha-deep);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }

  .result-date {
    margin: 0 0 0.85rem;
    font-size: 1.9rem;
    color: var(--text);
    font-weight: 700;
    font-family: "Cascadia Mono", monospace;
    letter-spacing: 0.04em;
  }

  /*
    Editable date sitting where the static .result-date used to be.
    Styled to read as the focal piece of the panel — large, centred,
    bold mono — but clearly tappable thanks to a subtle border.
  */
  .result-date-input {
    margin: 0 auto 0.4rem;
    display: block;
    width: 100%;
    max-width: 14rem;
    padding: 0.55rem 0.65rem;
    background: var(--surface);
    border: 1px solid var(--matcha);
    border-radius: var(--radius-sm);
    font: inherit;
    font-family: "Cascadia Mono", monospace;
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--text);
    text-align: center;
    letter-spacing: 0.03em;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .result-date-input:focus {
    border-color: var(--matcha-deep);
    box-shadow: 0 0 0 3px rgba(122, 139, 63, 0.25);
  }

  .result-date-input--error {
    border-color: var(--error);
    background: #fbecec;
  }

  .result-edit-hint {
    margin: 0 0 0.85rem;
    font-size: 0.78rem;
    color: var(--matcha-deep);
    opacity: 0.85;
  }

  .result-date-error {
    margin: 0 0 0.85rem;
    text-align: center;
  }

  .result-actions {
    display: flex;
    gap: 0.6rem;
    justify-content: center;
  }

  .btn-confirm,
  .btn-secondary {
    flex: 1;
    padding: 0.7rem 0.9rem;
    border-radius: var(--radius-pill);
    font: inherit;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .btn-confirm {
    background: var(--text);
    color: var(--background);
    border: none;
  }

  .btn-confirm:hover {
    background: #1f1916;
  }

  .btn-confirm:active,
  .btn-secondary:active {
    transform: translateY(1px);
  }

  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }

  .btn-secondary:hover {
    background: var(--background);
  }

  /* Manual entry section inside the result card (wrong-date re-scan path) */
  .result-manual {
    margin-top: 1rem;
    padding-top: 0.9rem;
    border-top: 1px solid rgba(122, 139, 63, 0.25);
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    text-align: left;
  }

  .result-manual-hint {
    margin: 0;
    font-size: 0.82rem;
    color: var(--matcha-deep);
  }

  /* Manual input panel (after failed cycles) */
  .manual-panel {
    margin-top: 0.85rem;
    padding: 0.9rem 1rem;
    background: var(--warn-soft);
    border-left: 3px solid var(--warn);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .manual-hint {
    margin: 0;
    font-size: 0.86rem;
    color: var(--text);
    line-height: 1.45;
  }

  .manual-hint code {
    background: rgba(194, 138, 47, 0.18);
    padding: 1px 5px;
    border-radius: var(--radius-xs);
    font-size: 0.82rem;
    font-family: "Cascadia Mono", monospace;
  }

  .manual-row {
    display: flex;
    gap: 0.5rem;
  }

  .manual-input {
    flex: 1;
    min-width: 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 1rem;
    background: var(--surface);
    color: var(--text);
    outline: none;
    transition: border-color 0.15s ease;
  }

  .manual-input:focus {
    border-color: var(--matcha);
    box-shadow: 0 0 0 3px var(--matcha-soft);
  }

  .manual-input--error {
    border-color: var(--error);
    background: #fbecec;
  }

  .btn-use {
    padding: 0.6rem 1.1rem;
    background: var(--text);
    color: var(--background);
    border: none;
    border-radius: var(--radius-pill);
    font: inherit;
    font-weight: 600;
    font-size: 0.92rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .btn-use:hover {
    background: #1f1916;
  }

  .btn-use:active {
    transform: translateY(1px);
  }

  .manual-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--error);
  }

  /* ── Inline error after a scan attempt ───────────────────────────── */
  .error-msg {
    margin: 0.6rem 0 0;
    padding: 0.5rem 0.75rem;
    color: var(--text);
    font-size: 0.88rem;
    background: var(--warn-soft);
    border-left: 3px solid var(--warn);
    border-radius: var(--radius-sm);
  }

  /* ── Dev preview / raw OCR panel (gated behind showDebug) ────────── */
  .preview-wrap {
    margin-top: 0.75rem;
    padding: 0.5rem;
    background: var(--background);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }

  .preview-canvas {
    width: 100%;
    max-height: 120px;
    object-fit: contain;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    image-rendering: pixelated;
  }

  .debug-panel {
    margin-top: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: var(--background);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    min-height: 3rem;
  }

  .raw-label {
    font-size: 0.7rem;
    color: var(--text);
    opacity: 0.6;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }

  .raw-output {
    display: block;
    font-family: "Cascadia Mono", monospace;
    color: var(--text);
    font-size: 0.95rem;
    padding: 0.25rem 0 0;
    word-break: break-all;
  }
</style>
