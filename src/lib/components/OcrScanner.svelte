<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { parseExpiryDate } from '$lib/utils/parseExpiryDate'

  export interface OcrProps {
    /** Called with "DD-MM-YYYY" once the user taps Confirm. */
    onDateFound: (date: string) => void
  }

  let { onDateFound }: OcrProps = $props()

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
  let failCount = $state(0)          // full scan cycles that found nothing
  let rescanCount = $state(0)        // times user tapped Re-scan on a wrong result
  let manualInput = $state('')
  let manualError = $state(false)

  // ===== Tunables =====
  const UPSCALE = 2
  // Show manual input after this many failed scan cycles (no date found at all)
  const SHOW_MANUAL_AFTER_FAIL = 2
  // Show manual input after this many Re-scan taps (date found but kept wrong)
  const SHOW_MANUAL_AFTER_RESCAN = 3
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
      } else {
        failCount += 1
        errorMessage = failCount >= SHOW_MANUAL_AFTER_FAIL
          ? 'Still struggling — type what you see below and tap Use.'
          : 'No date found. Try moving closer or improving lighting.'
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
    } else {
      manualError = true
    }
  }

  /** User confirmed the detected date — hand it off to the page. */
  function confirmDate() {
    if (!foundDate) return
    onDateFound(foundDate)
  }

  /** User rejected the detected date — clear it so they can re-scan. */
  function rescan() {
    foundDate = null
    errorMessage = null
    manualInput = ''
    manualError = false
    rescanCount += 1
    // Keep failCount so the fail-based manual input also stays visible
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
      <div class="scan-overlay"></div>
    {/if}

    {#if !isStarted}
      <div class="controls-overlay">
        <button onclick={startCamera} class="main-btn">Start Camera</button>
      </div>
    {/if}
  </div>

  <canvas bind:this={canvasElement} style="display: none;"></canvas>

  {#if isStarted}
    {#if foundDate}
      <div class="result-panel">
        <p class="result-label">Expiry date detected</p>
        <p class="result-date">{foundDate}</p>
        <div class="result-actions">
          <button onclick={rescan} class="btn-secondary">Re-scan</button>
          <button onclick={confirmDate} class="btn-confirm">Confirm</button>
        </div>

        <!-- After 3 re-scans, offer manual entry right inside the result card -->
        {#if rescanCount >= SHOW_MANUAL_AFTER_RESCAN}
          <div class="result-manual">
            <p class="result-manual-hint">Not right? Type the date you see on the label:</p>
            <div class="manual-row">
              <input
                class="manual-input"
                class:manual-input--error={manualError}
                type="text"
                inputmode="numeric"
                placeholder="e.g. 10 03 27"
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
      </div>
    {:else}
      <div class="actions">
        <button onclick={scanText} disabled={isScanning} class="main-btn">
          {#if isScanning}
            Reading…
          {:else}
            Scan Expiry Date
          {/if}
        </button>
      </div>
    {/if}

    <!-- Manual input — appears after SHOW_MANUAL_AFTER_FAIL failed cycles (no date found) -->
    {#if failCount >= SHOW_MANUAL_AFTER_FAIL && !foundDate}
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

    <div class="preview-wrap">
      <p class="raw-label">Preview:</p>
      <canvas bind:this={previewCanvas} class="preview-canvas"></canvas>
    </div>

    <div class="debug-panel">
      {#if lastRawText}
        <p class="raw-label">Google Vision read:</p>
        <code class="raw-output">"{lastRawText}"</code>
      {/if}
      {#if errorMessage}
        <p class="error-msg">{errorMessage}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ocr-container {
    width: 100%;
    max-width: 500px;
    margin: auto;
  }
  .video-wrapper {
    position: relative;
    width: 100%;
    aspect-ratio: 16/9;
    background: #000;
    border-radius: 12px;
    overflow: hidden;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .scan-overlay {
    position: absolute;
    left: 15%;   /* (1 - CROP_W_RATIO 0.7) / 2 = 0.15 */
    top: 10%;    /* CROP_Y_RATIO 0.1 */
    width: 70%;  /* CROP_W_RATIO 0.7 */
    height: 25%; /* CROP_H_RATIO 0.25 */
    border: 3px solid #00ff88;
    border-radius: 8px;
    pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
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
    margin-top: 1rem;
  }
  .main-btn {
    width: 100%;
    padding: 14px;
    background: #6366f1;
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: bold;
    cursor: pointer;
  }
  .main-btn:disabled {
    background: #4b4b6b;
    cursor: not-allowed;
  }

  .result-panel {
    margin-top: 1rem;
    padding: 16px;
    background: #ecfdf5;
    border: 2px solid #10b981;
    border-radius: 10px;
    text-align: center;
  }
  .result-label {
    margin: 0 0 4px 0;
    font-size: 0.8rem;
    color: #065f46;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .result-date {
    margin: 0 0 12px 0;
    font-size: 2rem;
    color: #064e3b;
    font-weight: 700;
    font-family: monospace;
    letter-spacing: 0.05em;
  }
  .result-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
  .btn-confirm {
    flex: 1;
    padding: 12px;
    background: #10b981;
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: bold;
    cursor: pointer;
    font-size: 1rem;
  }
  .btn-secondary {
    flex: 1;
    padding: 12px;
    background: #e4e4e7;
    color: #18181b;
    border: none;
    border-radius: 8px;
    font-weight: bold;
    cursor: pointer;
    font-size: 1rem;
  }

  /* Manual entry section inside the result card (wrong-date re-scan path) */
  .result-manual {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid #d1fae5;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .result-manual-hint {
    margin: 0;
    font-size: 0.82rem;
    color: #065f46;
  }

  /* Manual input panel */
  .manual-panel {
    margin-top: 1rem;
    padding: 14px;
    background: #fefce8;
    border: 1.5px solid #fbbf24;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .manual-hint {
    margin: 0;
    font-size: 0.85rem;
    color: #78350f;
    line-height: 1.4;
  }
  .manual-hint code {
    background: #fde68a;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.8rem;
  }
  .manual-row {
    display: flex;
    gap: 8px;
  }
  .manual-input {
    flex: 1;
    padding: 10px 12px;
    border: 1.5px solid #d97706;
    border-radius: 8px;
    font-size: 1rem;
    background: #fff;
    color: #1c1917;
    outline: none;
    transition: border-color 0.15s;
  }
  .manual-input:focus { border-color: #92400e; }
  .manual-input--error { border-color: #dc2626; background: #fef2f2; }
  .btn-use {
    padding: 10px 18px;
    background: #d97706;
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s;
  }
  .btn-use:hover { opacity: 0.85; }
  .manual-error {
    margin: 0;
    font-size: 0.8rem;
    color: #dc2626;
  }

  .preview-wrap {
    margin-top: 0.75rem;
    padding: 8px;
    background: #f4f4f5;
    border-radius: 8px;
    border: 1px solid #e4e4e7;
  }
  .preview-canvas {
    width: 100%;
    max-height: 120px;
    object-fit: contain;
    background: #fff;
    border: 1px solid #e4e4e7;
    border-radius: 4px;
    image-rendering: pixelated;
  }

  /* Debug Styling */
  .debug-panel {
    margin-top: 1rem;
    padding: 10px;
    background: #f4f4f5;
    border-radius: 8px;
    border: 1px solid #e4e4e7;
    min-height: 60px;
  }
  .raw-label {
    font-size: 0.7rem;
    color: #71717a;
    text-transform: uppercase;
    margin: 0;
  }
  .raw-output {
    display: block;
    font-family: monospace;
    color: #18181b;
    font-size: 1.1rem;
    padding: 4px 0;
    word-break: break-all;
  }
  .error-msg {
    color: #dc2626;
    font-size: 0.9rem;
    margin-top: 4px;
    font-weight: 500;
  }
</style>
