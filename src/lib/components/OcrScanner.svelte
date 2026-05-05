<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  export interface OcrProps {
    onDateFound: (date: string) => void | Promise<void>
  }

  let { onDateFound }: OcrProps = $props()

  // ── DOM refs ────────────────────────────────────────────────────────────────
  let videoElement   = $state<HTMLVideoElement | null>(null)
  let canvasElement  = $state<HTMLCanvasElement | null>(null)
  let debugCanvas    = $state<HTMLCanvasElement | null>(null)

  // ── Tesseract ───────────────────────────────────────────────────────────────
  let Tesseract      = $state<any>(null)
  let tesseractWorker = $state<any>(null)

  // ── Component state ─────────────────────────────────────────────────────────
  let isStarted      = $state(false)
  let isScanning     = $state(false)
  let errorMessage   = $state<string | null>(null)
  let lastRawText    = $state('')
  let stream         = $state<MediaStream | null>(null)
  let scanLoop       = $state<ReturnType<typeof setInterval> | null>(null)
  let statusMsg      = $state('Align expiry date inside the box')
  let attemptCount   = $state(0)
  let showDebugFrame = $state(false)   // true for 800 ms after each scan

  // ── Year-confirmation dialog state ──────────────────────────────────────────
  let pendingPartialDate = $state<{ day: number; month: number } | null>(null)

  // ── Manual Entry State ────────────────────────────────────────────────────
  let isManualMode = $state(false)
  let manDay       = $state('')
  let manMonth     = $state('')
  let manYear      = $state(new Date().getFullYear().toString())
  let manError     = $state<string | null>(null)

  const SCAN_INTERVAL_MS    = 1500
  const DEBUG_FLASH_MS      = 800
  const ADAPTIVE_RADIUS     = 12   // local neighbourhood half-size for threshold
  const DILATION_RADIUS     = 2    // gives a 5×5 structuring element (r=2 → 2r+1=5)

  // ────────────────────────────────────────────────────────────────────────────
  // MONTH MAP  (Swedish + English, full names + abbreviations)
  // ────────────────────────────────────────────────────────────────────────────
  const MONTH_MAP: Record<string, number> = {
    // ── English full ───────────────────────────────────────────────────────
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    // ── English 3-char ────────────────────────────────────────────────────
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
    aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    // ── Swedish full ──────────────────────────────────────────────────────
    januari: 1, februari: 2, mars: 3, maj: 5, juni: 6,
    juli: 7, augusti: 8, oktober: 10,
    // ── Swedish abbreviations ─────────────────────────────────────────────
    okt: 10,
  }

  // ────────────────────────────────────────────────────────────────────────────
  // COMPREHENSIVE OCR ERROR MAP
  // ────────────────────────────────────────────────────────────────────────────
  const OCR_FIXES: Record<string, string> = {
    'nai':  'maj',
    'ma1':  'maj',
    'naj':  'maj',
    'mai':  'maj',
    'ma|':  'maj',
    'rnaj': 'maj',
    'rnar': 'mar',
    'rnaJ': 'maj',
    'jun':  'jun',
    'jün':  'jun',
    '0kt':  'okt',
    '0ct':  'oct',
    '5ep':  'sep',
    '5ept': 'sept',
    '4pr':  'apr',
    'feé':  'feb',
    'fe8':  'feb',
    'de6':  'dec',
    'de<':  'dec',
    'nov':  'nov',
    'n0v':  'nov',
    'n0vember': 'november',
    '0ctober':  'october',
    '5eptember':'september',
    'b':  '8',
    'o':  '0',
    'i':  '1',
    'l':  '1',
    's':  '5',
  }

  // ────────────────────────────────────────────────────────────────────────────
  // LEVENSHTEIN  (iterative, O(min(m,n)) space)
  // ────────────────────────────────────────────────────────────────────────────
  function levenshtein(a: string, b: string): number {
    if (a === b) return 0
    if (a.length === 0) return b.length
    if (b.length === 0) return a.length
    if (a.length > b.length) [a, b] = [b, a]

    let prev = Array.from({ length: a.length + 1 }, (_, i) => i)
    for (let j = 1; j <= b.length; j++) {
      const curr = [j]
      for (let i = 1; i <= a.length; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost)
      }
      prev = curr
    }
    return prev[a.length]
  }

  // ────────────────────────────────────────────────────────────────────────────
  // FUZZY MONTH LOOKUP  (exact → OCR_FIXES map → Levenshtein ≤ 1)
  // ────────────────────────────────────────────────────────────────────────────
  function fuzzyMonth(raw: string): number | null {
    const token = raw.toLowerCase().trim()
    if (!token) return null

    if (MONTH_MAP[token] !== undefined) return MONTH_MAP[token]

    const fixed = OCR_FIXES[token]
    if (fixed && MONTH_MAP[fixed] !== undefined) return MONTH_MAP[fixed]

    let bestDist  = Infinity
    let bestMonth = 0
    for (const [key, month] of Object.entries(MONTH_MAP)) {
      if (Math.abs(key.length - token.length) > 1) continue
      const d = levenshtein(token, key)
      if (d < bestDist) { bestDist = d; bestMonth = month }
    }
    return bestDist <= 1 ? bestMonth : null
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DATE PARSER
  // ────────────────────────────────────────────────────────────────────────────
  type ParseResult =
    | { type: 'full';    date: string }
    | { type: 'partial'; day: number; month: number }

  function cleanDigitRun(s: string): string {
    return s
      .replace(/[Oo]/g,   '0')
      .replace(/[Il|]/g,  '1')
      .replace(/[Ss]/g,   '5')
      .replace(/[Bb]/g,   '8')
      .replace(/[Zz]/g,   '2')
      .replace(/[Gg]/g,   '6')
      .replace(/[Tt]/g,   '7')
  }

  function findDate(text: string): ParseResult | null {
    if (!text) return null
    const normalised = text.replace(/\s+/g, ' ').trim()
    const pad = (n: number) => n.toString().padStart(2, '0')

    const numCleaned = normalised.replace(/\d+/g, m => cleanDigitRun(m))
    const numPattern = /\b(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2,4})\b/
    const numMatch   = numCleaned.match(numPattern)

    if (numMatch) {
      const d = parseInt(numMatch[1])
      const m = parseInt(numMatch[2])
      let   y = parseInt(numMatch[3])
      if (numMatch[3].length === 2) y += 2000
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2024 && y <= 2099) {
        return { type: 'full', date: `${pad(d)}-${pad(m)}-${y}` }
      }
    }

    const semDayFirst = normalised.match(
      /\b(\d{1,2})\s+([A-Za-zÅÄÖåäöüÜ]{2,9})(?:\s+(\d{2,4}))?\b/
    )
    if (semDayFirst) {
      const d      = parseInt(cleanDigitRun(semDayFirst[1]))
      const mToken = semDayFirst[2]
      const yRaw   = semDayFirst[3]
      const m      = fuzzyMonth(mToken)
      if (m !== null && d >= 1 && d <= 31) {
        if (yRaw) {
          let y = parseInt(cleanDigitRun(yRaw))
          if (yRaw.length === 2) y += 2000
          if (y >= 2024 && y <= 2099) return { type: 'full', date: `${pad(d)}-${pad(m)}-${y}` }
        }
        return { type: 'partial', day: d, month: m }
      }
    }

    const semMonthFirst = normalised.match(
      /\b([A-Za-zÅÄÖåäöüÜ]{2,9})\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/
    )
    if (semMonthFirst) {
      const mToken = semMonthFirst[1]
      const d      = parseInt(cleanDigitRun(semMonthFirst[2]))
      const yRaw   = semMonthFirst[3]
      const m      = fuzzyMonth(mToken)
      if (m !== null && d >= 1 && d <= 31) {
        if (yRaw) {
          let y = parseInt(cleanDigitRun(yRaw))
          if (yRaw.length === 2) y += 2000
          if (y >= 2024 && y <= 2099) return { type: 'full', date: `${pad(d)}-${pad(m)}-${y}` }
        }
        return { type: 'partial', day: d, month: m }
      }
    }

    return null
  }

  // ────────────────────────────────────────────────────────────────────────────
  // YEAR-CONFIRMATION HELPERS
  // ────────────────────────────────────────────────────────────────────────────
  const CURRENT_YEAR = new Date().getFullYear()

  function suggestedYear(day: number, month: number): number {
    const today     = new Date()
    const candidate = new Date(CURRENT_YEAR, month - 1, day)
    return candidate >= today ? CURRENT_YEAR : CURRENT_YEAR + 1
  }

  async function confirmYear(year: number): Promise<void> {
    if (!pendingPartialDate) return
    const { day, month } = pendingPartialDate
    const pad = (n: number) => n.toString().padStart(2, '0')
    pendingPartialDate = null
    statusMsg = 'Date confirmed!'
    await onDateFound(`${pad(day)}-${pad(month)}-${year}`)
  }

  function dismissYearDialog(): void {
    pendingPartialDate = null
    statusMsg = 'Align expiry date inside the box'
    startScanLoop()
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PREPROCESSING PIPELINE — ADVANCED
  // ────────────────────────────────────────────────────────────────────────────
  function applySharpening(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
    const src    = new Uint8ClampedArray(data)
    const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0]
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              acc += src[((y + ky) * width + (x + kx)) * 4 + c] * kernel[(ky + 1) * 3 + (kx + 1)]
            }
          }
          data[(y * width + x) * 4 + c] = Math.min(255, Math.max(0, acc))
        }
      }
    }
    return data
  }

  const ADAPTIVE_BIAS = 0.85

  function applyAdaptiveThreshold(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
    const sat = new Float64Array((width + 1) * (height + 1))
    for (let y = 1; y <= height; y++) {
      for (let x = 1; x <= width; x++) {
        const pIdx = ((y - 1) * width + (x - 1)) * 4
        const luma = 0.2126 * data[pIdx] + 0.7152 * data[pIdx + 1] + 0.0722 * data[pIdx + 2]
        sat[y * (width + 1) + x] = luma + sat[(y - 1) * (width + 1) + x] + sat[y * (width + 1) + (x - 1)] - sat[(y - 1) * (width + 1) + (x - 1)]
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const x1 = Math.max(0, x - radius)
        const y1 = Math.max(0, y - radius)
        const x2 = Math.min(width  - 1, x + radius)
        const y2 = Math.min(height - 1, y + radius)
        const count = (x2 - x1 + 1) * (y2 - y1 + 1)
        const sum = sat[(y2 + 1) * (width + 1) + (x2 + 1)] - sat[(y1) * (width + 1) + (x2 + 1)] - sat[(y2 + 1) * (width + 1) + (x1)] + sat[(y1) * (width + 1) + (x1)]
        const mean   = sum / count
        const pIdx   = (y * width + x) * 4
        const luma   = 0.2126 * data[pIdx] + 0.7152 * data[pIdx + 1] + 0.0722 * data[pIdx + 2]
        const binary = luma < mean * ADAPTIVE_BIAS ? 0 : 255
        data[pIdx]     = binary
        data[pIdx + 1] = binary
        data[pIdx + 2] = binary
      }
    }
  }

  function applyDilation(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
    const offsets: Array<[number, number]> = []
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) offsets.push([dy, dx])
      }
    }
    const src = new Uint8ClampedArray(data)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pIdx = (y * width + x) * 4
        if (src[pIdx] === 0) {
          data[pIdx] = data[pIdx + 1] = data[pIdx + 2] = 0
          continue
        }
        let hitBlack = false
        for (const [dy, dx] of offsets) {
          const ny = y + dy
          const nx = x + dx
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue
          if (src[(ny * width + nx) * 4] === 0) { hitBlack = true; break }
        }
        const val = hitBlack ? 0 : 255
        data[pIdx] = data[pIdx + 1] = data[pIdx + 2] = val
      }
    }
  }

  function preprocessFrame(ctx: CanvasRenderingContext2D, cropWidth: number, cropHeight: number, cropX: number, cropY: number): string {
    ctx.filter = 'grayscale(1) contrast(3.5) brightness(1.15)'
    ctx.drawImage(videoElement!, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
    ctx.filter = 'none'

    const imageData = ctx.getImageData(0, 0, cropWidth, cropHeight)
    applySharpening(imageData.data, cropWidth, cropHeight)
    applyAdaptiveThreshold(imageData.data, cropWidth, cropHeight, ADAPTIVE_RADIUS)
    applyDilation(imageData.data, cropWidth, cropHeight, DILATION_RADIUS)

    ctx.putImageData(imageData, 0, 0)
    if (debugCanvas) {
      debugCanvas.width  = cropWidth
      debugCanvas.height = cropHeight
      const dCtx = debugCanvas.getContext('2d')
      if (dCtx) dCtx.putImageData(imageData, 0, 0)
    }
    return canvasElement!.toDataURL('image/png')
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CAMERA
  // ────────────────────────────────────────────────────────────────────────────
  async function startCamera(): Promise<void> {
    errorMessage = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      if (videoElement) {
        videoElement.srcObject = stream
        videoElement.onloadedmetadata = () => {
          isStarted = true
          startScanLoop()
        }
      }
    } catch {
      errorMessage = 'Camera access denied. Please allow camera permissions.'
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN LOOP
  // ────────────────────────────────────────────────────────────────────────────
  function startScanLoop(): void {
    if (scanLoop !== null) return
    scanLoop = setInterval(performScan, SCAN_INTERVAL_MS)
  }

  function stopScanLoop(): void {
    if (scanLoop !== null) {
      clearInterval(scanLoop)
      scanLoop = null
    }
  }

  let debugFlashTimer: ReturnType<typeof setTimeout> | null = null

  async function performScan(): Promise<void> {
    if (!videoElement || !canvasElement || !Tesseract || isScanning) return
    isScanning   = true
    attemptCount++
    statusMsg    = 'Analyzing…'
    errorMessage = null

    try {
      const ctx = canvasElement.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      const srcW = videoElement.videoWidth
      const srcH = videoElement.videoHeight
      const cropW = Math.floor(srcW * 0.8)
      const cropH = Math.floor(srcH * 0.38)
      const cropX = Math.floor((srcW - cropW) / 2)
      const cropY = Math.floor(srcH * 0.05)
      canvasElement.width  = cropW
      canvasElement.height = cropH

      const imageDataUrl = preprocessFrame(ctx, cropW, cropH, cropX, cropY)
      if (debugFlashTimer !== null) clearTimeout(debugFlashTimer)
      showDebugFrame = true
      debugFlashTimer = setTimeout(() => { showDebugFrame = false }, DEBUG_FLASH_MS)

      const result = await Tesseract.recognize(imageDataUrl, 'eng', {
        tessedit_pageseg_mode: 7,
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/.- ',
        oem: 1,
      })

      lastRawText = result.data.text.trim()
      const parsed = findDate(lastRawText)

      if (parsed?.type === 'full') {
        stopScanLoop()
        statusMsg = 'Date found!'
        await onDateFound(parsed.date)
      } else if (parsed?.type === 'partial') {
        stopScanLoop()
        statusMsg          = 'Partial date found — please confirm the year'
        pendingPartialDate = { day: parsed.day, month: parsed.month }
      } else {
        statusMsg = 'Align expiry date inside the box'
      }
    } catch {
      statusMsg = 'Align expiry date inside the box'
    } finally {
      isScanning = false
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MANUAL ENTRY LOGIC
  // ────────────────────────────────────────────────────────────────────────────
  function enableManualMode() {
    stopScanLoop()
    if (debugFlashTimer !== null) clearTimeout(debugFlashTimer)
    stream?.getTracks().forEach(t => t.stop())
    isStarted = false
    isManualMode = true
  }

  function cancelManualMode() {
    isManualMode = false
    manError = null
    manDay = ''
    manMonth = ''
    manYear = new Date().getFullYear().toString()
  }

  async function submitManualDate() {
    manError = null
    
    const d = parseInt(manDay.trim(), 10)
    const y = parseInt(manYear.trim(), 10)
    
    // Parse month numerically first, fallback to text matching if it's NaN
    let m = parseInt(manMonth.trim(), 10)
    if (isNaN(m) || m < 1 || m > 12) {
      const fuzzyMatch = fuzzyMonth(manMonth)
      if (fuzzyMatch !== null) {
        m = fuzzyMatch
      } else {
        m = NaN // Explicitly set to NaN so the next check catches it if it failed completely
      }
    }

    if (isNaN(d) || d < 1 || d > 31) {
      manError = 'Please enter a valid day (1-31).'
      return
    }
    if (isNaN(m) || m < 1 || m > 12) {
      manError = 'Please enter a valid month (1-12, or month name).'
      return
    }
    if (isNaN(y) || y < 2024 || y > 2099) {
      manError = 'Please enter a valid year.'
      return
    }

    const pad = (n: number) => n.toString().padStart(2, '0')
    await onDateFound(`${pad(d)}-${pad(m)}-${y}`)
  }

  // ────────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ────────────────────────────────────────────────────────────────────────────
  onMount(async () => {
    try {
      const mod = await import('tesseract.js')
      Tesseract = mod.default || mod
    } catch {
      errorMessage = 'OCR library failed to load. Try refreshing the page.'
    }
  })

  onDestroy(() => {
    stopScanLoop()
    if (debugFlashTimer !== null) clearTimeout(debugFlashTimer)
    stream?.getTracks().forEach(t => t.stop())
    tesseractWorker?.terminate?.()
  })

  const MONTH_NAMES_EN = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const MONTH_NAMES_SV = [
    '', 'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
    'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
  ]
</script>

<div class="ocr-container">
  {#if isManualMode}
    <!-- ── Manual Entry Form ─────────────────────────────────────────────── -->
    <div class="manual-form">
      <h3 class="manual-title">Enter Expiry Manually</h3>
      <p class="manual-hint">Type the date exactly as seen on the label.</p>

      <div class="input-row">
        <div class="input-col">
          <label for="manDay">Day</label>
          <input id="manDay" type="text" placeholder="DD" bind:value={manDay} maxlength="2" />
        </div>
        <div class="input-col">
          <label for="manMonth">Month</label>
          <input id="manMonth" type="text" placeholder="MM or Maj" bind:value={manMonth} />
        </div>
        <div class="input-col">
          <label for="manYear">Year</label>
          <input id="manYear" type="text" bind:value={manYear} maxlength="4" />
        </div>
      </div>

      {#if manError}
        <p class="error-msg">{manError}</p>
      {/if}

      <div class="manual-actions">
        <button class="main-btn" onclick={submitManualDate}>Confirm Date</button>
        <button class="year-btn-dismiss" style="margin-top: 8px;" onclick={cancelManualMode}>
          Cancel & Return to Scanner
        </button>
      </div>
    </div>
  {:else}
    <!-- ── Existing Scanner UI ─────────────────────────────────────────────── -->
    <div class="video-wrapper">
      <video bind:this={videoElement} autoplay playsinline muted></video>

      {#if isStarted}
        <div class="scan-overlay">
          <span class="overlay-hint">Expiry date here</span>
        </div>

        <div class="scan-status" class:scanning={isScanning}>
          <span class="pulse-dot"></span>
          <span class="status-text">{statusMsg}</span>
        </div>
      {/if}

      {#if !isStarted}
        <div class="controls-overlay">
          <p class="camera-hint">Point at the expiry date on the bottle</p>
          <button onclick={startCamera} class="main-btn">Start Camera</button>
          <button onclick={enableManualMode} class="ghost-btn">Can't scan? Enter manually</button>
        </div>
      {/if}
    </div>

    <!-- Fallback button when scanner is actively running -->
    {#if isStarted}
      <div class="fallback-container">
        <button onclick={enableManualMode} class="ghost-btn">Can't scan? Enter manually</button>
      </div>
    {/if}

    <canvas bind:this={canvasElement} style="display: none;"></canvas>

    <div class="debug-preview-wrapper" class:debug-visible={showDebugFrame}>
      <span class="debug-preview-label">⚙ PREPROCESSED FRAME</span>
      <canvas bind:this={debugCanvas} class="debug-preview-canvas"></canvas>
    </div>

    {#if pendingPartialDate}
      {@const { day, month } = pendingPartialDate}
      {@const suggested   = suggestedYear(day, month)}
      {@const other       = suggested === CURRENT_YEAR ? CURRENT_YEAR + 1 : CURRENT_YEAR}
      {@const monthLabel  = `${MONTH_NAMES_EN[month]} / ${MONTH_NAMES_SV[month]}`}
      {@const dayLabel    = day.toString().padStart(2, '0')}

      <div class="year-backdrop" role="dialog" aria-modal="true" aria-label="Confirm expiry year">
        <div class="year-dialog">
          <p class="year-dialog-eyebrow">Partial date detected</p>
          <p class="year-dialog-date">{dayLabel} {monthLabel}</p>
          <p class="year-dialog-question">Which year is on the label?</p>

          <div class="year-dialog-choices">
            <button class="year-btn year-btn--primary" onclick={() => confirmYear(suggested)}>
              {suggested}
              <span class="year-btn-hint">{suggested === CURRENT_YEAR ? 'This year' : 'Next year'}</span>
            </button>
            <button class="year-btn year-btn--secondary" onclick={() => confirmYear(other)}>
              {other}
              <span class="year-btn-hint">{other === CURRENT_YEAR ? 'This year' : 'Next year'}</span>
            </button>
          </div>

          <button class="year-btn-dismiss" onclick={dismissYearDialog}>
            ↩ Try scanning again
          </button>
        </div>
      </div>
    {/if}

    {#if isStarted}
      <div class="debug-panel">
        <p class="attempt-label">Scan attempt #{attemptCount}</p>
        {#if lastRawText}
          <p class="raw-label">Machine read:</p>
          <code class="raw-output">"{lastRawText}"</code>
        {/if}
        {#if errorMessage}
          <p class="error-msg">{errorMessage}</p>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* ── All original CSS preserved perfectly ────────────────────────────── */
  .ocr-container { width: 100%; max-width: 500px; margin: auto; }
  .video-wrapper { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: cover; }
  .scan-overlay { position: absolute; left: 10%; top: 5%; width: 80%; height: 38%; border: 2px solid #00ff88; border-radius: 8px; pointer-events: none; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45); display: flex; align-items: flex-end; justify-content: center; padding-bottom: 6px; }
  .overlay-hint { color: #00ff88; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; background: rgba(0, 0, 0, 0.5); padding: 2px 8px; border-radius: 4px; }
  .scan-status { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; background: rgba(0, 0, 0, 0.65); color: #fff; padding: 5px 12px; border-radius: 20px; font-size: 0.8rem; }
  .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: #00ff88; flex-shrink: 0; }
  .scanning .pulse-dot { animation: pulse 0.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }
  .controls-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; background: rgba(0, 0, 0, 0.8); padding: 1rem; }
  .camera-hint { color: #a1a1aa; font-size: 0.9rem; text-align: center; margin: 0; }
  .main-btn { width: 200px; padding: 14px; background: #6366f1; color: white; border: none; border-radius: 8px; font-weight: bold; font-size: 1rem; cursor: pointer; transition: background 0.15s; }
  .main-btn:hover { background: #4f46e5; }
  .debug-preview-wrapper { position: relative; margin-top: 0.5rem; border-radius: 8px; overflow: hidden; border: 2px solid transparent; max-height: 0; opacity: 0; transition: max-height 0.15s ease, opacity 0.15s ease, border-color 0.15s ease; }
  .debug-preview-wrapper.debug-visible { max-height: 160px; opacity: 1; border-color: #00ff88; }
  .debug-preview-label { position: absolute; top: 4px; left: 6px; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; color: #00ff88; background: rgba(0, 0, 0, 0.75); padding: 1px 5px; border-radius: 3px; z-index: 1; pointer-events: none; }
  .debug-preview-canvas { display: block; width: 100%; height: auto; background: #000; image-rendering: pixelated; }
  .year-backdrop { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(4px); animation: fadeIn 0.18s ease; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .year-dialog { background: #18181b; border: 1px solid #3f3f46; border-radius: 16px; padding: 1.75rem 1.5rem 1.25rem; width: 100%; max-width: 340px; text-align: center; animation: slideUp 0.22s cubic-bezier(0.34, 1.56, 0.64, 1); }
  @keyframes slideUp { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .year-dialog-eyebrow { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #71717a; margin: 0 0 0.5rem; }
  .year-dialog-date { font-size: 1.6rem; font-weight: 700; color: #00ff88; margin: 0 0 0.25rem; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .year-dialog-question { font-size: 0.85rem; color: #a1a1aa; margin: 0 0 1.25rem; }
  .year-dialog-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1rem; }
  .year-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0.875rem 0.5rem; border-radius: 10px; border: none; cursor: pointer; transition: transform 0.1s, opacity 0.1s; font-family: inherit; line-height: 1.2; }
  .year-btn:active { transform: scale(0.96); }
  .year-btn--primary { background: #6366f1; color: #fff; font-size: 1.35rem; font-weight: 700; }
  .year-btn--primary:hover { background: #4f46e5; }
  .year-btn--secondary { background: #27272a; color: #d4d4d8; font-size: 1.35rem; font-weight: 700; border: 1px solid #3f3f46; }
  .year-btn--secondary:hover { background: #3f3f46; }
  .year-btn-hint { font-size: 0.65rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin-top: 3px; }
  .year-btn-dismiss { background: none; border: none; color: #52525b; font-size: 0.8rem; cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: color 0.15s; font-family: inherit; }
  .year-btn-dismiss:hover { color: #a1a1aa; }
  .debug-panel { margin-top: 1rem; padding: 10px; background: #f4f4f5; border-radius: 8px; border: 1px solid #e4e4e7; min-height: 60px; }
  .attempt-label { font-size: 0.7rem; color: #a1a1aa; margin: 0 0 4px; }
  .raw-label { font-size: 0.7rem; color: #71717a; text-transform: uppercase; margin: 0; }
  .raw-output { display: block; font-family: monospace; color: #18181b; font-size: 1rem; padding: 4px 0; word-break: break-all; }
  .error-msg { color: #dc2626; font-size: 0.9rem; margin-top: 4px; font-weight: 500; }

  /* ── New Styles for Manual Entry ──────────────────────────────────────── */
  .fallback-container {
    text-align: center;
    margin-top: 1rem;
  }
  
  .ghost-btn {
    background: none;
    border: none;
    color: #a1a1aa;
    text-decoration: underline;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 8px;
    font-family: inherit;
  }
  
  .ghost-btn:hover {
    color: #fff;
  }

  .manual-form {
    background: #18181b;
    border: 1px solid #3f3f46;
    border-radius: 12px;
    padding: 1.5rem;
    color: #fff;
    text-align: center;
  }

  .manual-title {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
    color: #f4f4f5;
  }

  .manual-hint {
    margin: 0 0 1.5rem;
    font-size: 0.85rem;
    color: #a1a1aa;
  }

  .input-row {
    display: flex;
    gap: 10px;
    margin-bottom: 1.5rem;
  }

  .input-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    text-align: left;
  }

  .input-col label {
    font-size: 0.75rem;
    font-weight: 600;
    color: #a1a1aa;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .input-col input {
    background: #27272a;
    border: 1px solid #3f3f46;
    color: #fff;
    padding: 12px;
    border-radius: 8px;
    font-size: 1rem;
    text-align: center;
    font-family: inherit;
  }

  .input-col input:focus {
    outline: none;
    border-color: #6366f1;
  }

  .manual-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
</style>