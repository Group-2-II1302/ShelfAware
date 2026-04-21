<script lang="ts">
    import { onMount, onDestroy } from 'svelte';

    // Export the interface so +page.svelte can see exactly what it needs to provide
    export interface OcrProps {
        ondatefound: (date: string) => void | Promise<void>;
    }

    let { ondatefound }: OcrProps = $props();

    let videoElement = $state<HTMLVideoElement | null>(null);
    let canvasElement = $state<HTMLCanvasElement | null>(null);
    let Tesseract = $state<any>(null);
    
    let isStarted = $state(false);   // camera stream is active
    let isScanning = $state(false); // prevents overlapping OCR calls
    let errorMessage = $state<string | null>(null);
    let lastRawText = $state<string>(""); // For UI feedback/debugging of the OCR output
    let stream = $state<MediaStream | null>(null);

function findDate(text: string): string {
    if (!text) return '';

    // OCR Cleanup: Standardize common misreads
    const cleaned = text
      .replace(/[Oo]/g, '0')   // Letter O to Number 0
      .replace(/[ISl|]/g, '1') // Vertical lines to Number 1
      .replace(/[zZ]/g, '2')   // Letter Z to Number 2
      .replace(/\s+/g, ' ');   // Turn newlines/tabs into single spaces

    // The Pattern: (Day) (Month) (Year)
    // We use parenthesis () to create "groups" we can extract easily
    const pattern = /\b(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2,4})\b/;
    const match = cleaned.match(pattern);

    if (match) {
      // match[1] = Day, match[2] = Month, match[3] = Year
      const d = parseInt(match[1]);
      const m = parseInt(match[2]);
      let y = parseInt(match[3]);

      // Handle 2-digit years (e.g., '26' becomes 2026)
      if (match[3].length === 2) {
          y += 2000;
      }

      // ====== THE GUARD RAILS ======
      // Logic to ensure the extracted numbers actually represent a valid expiry date
      const isDayValid = d >= 1 && d <= 31;
      const isMonthValid = m >= 1 && m <= 12;
      // Must be 20xx and >= 2026
      const isYearValid = y >= 2026 && y <= 2099; 

      if (isDayValid && isMonthValid && isYearValid) {
        // SUCCESS: Format to a clean string (DD-MM-YYYY)
        const pad = (num: number) => num.toString().padStart(2, '0');
        return `${pad(d)}-${pad(m)}-${y}`;
      } else {
        // Log to console so we can see why a scan was rejected
        console.warn("Date rejected by guard rails:", { d, m, y });
      }
    }
    
    return '';
  }

    async function startCamera() {
        // Reset UI state before attempting access
        errorMessage = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }, // Use back camera on mobile
                audio: false
            });
            if (videoElement) {
                videoElement.srcObject = stream;
                // Only mark as started once the video metadata is ready
                videoElement.onloadedmetadata = () => isStarted = true;
            }
        } catch (err) {
            errorMessage = "Camera access denied.";
        }
    }

async function scanText() {
    // Prevent weird edge cases: scan in progress / missing elements / library not ready
    if (!videoElement || !canvasElement || !Tesseract || isScanning) return;

    isScanning = true;
    errorMessage = null;
    lastRawText = ""; 

    try {
      const context = canvasElement.getContext('2d', { willReadFrequently: true });
      if (!context) return;

      const sourceWidth = videoElement.videoWidth;
      const sourceHeight = videoElement.videoHeight;

      // Crop coordinates
      const cropWidth = Math.floor(sourceWidth * 0.8);
      const cropHeight = Math.floor(sourceHeight * 0.38);
      const cropX = Math.floor((sourceWidth - cropWidth) / 2);
      const cropY = Math.floor(sourceHeight * 0.05);

      canvasElement.width = cropWidth;
      canvasElement.height = cropHeight;

      // Pre-processing for clarity: Contrast/Grayscale helps OCR accuracy
      context.filter = 'contrast(1.5) grayscale(1)';
      context.drawImage(videoElement, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

      const imageDataUrl = canvasElement.toDataURL('image/png');

      // OCR Execution - Using stable numeric parameters
      const result = await Tesseract.recognize(imageDataUrl, 'eng', {
        // PSM 3 is "Fully automatic page segmentation" - most stable
        tessedit_pageseg_mode: 3 
      });

      lastRawText = result.data.text;
      const cleanDate = findDate(lastRawText);

      if (cleanDate) {
        // Success: Hand the cleaned date back to the parent component
        await ondatefound(cleanDate);
      } else {
        // ====== NEW: Invalid Date feedback message ======
        errorMessage = "Invalid Date, try again";
      }
    } catch (err) {
      console.error("Internal OCR Error:", err);
      errorMessage = "Scan failed. Check lighting.";
    } finally {
      isScanning = false;
    }
  }
  
onMount(async () => {
    // Lazy load Tesseract to keep initial bundle size small
    try {
        const mod = await import('tesseract.js');
        // This handles both ESM and CJS import styles
        Tesseract = mod.default || mod;
    } catch (e) {
        console.error("Failed to load Tesseract:", e);
        errorMessage = "OCR Library failed to load.";
    }
});

onDestroy(() => {
    // Clean up hardware resources immediately
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
});
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
        <div class="actions">
            <button onclick={scanText} disabled={isScanning} class="main-btn">
                {isScanning ? 'Reading...' : 'Scan Expiry Date'}
            </button>
        </div>

        <div class="debug-panel">
            {#if lastRawText}
                <p class="raw-label">Machine read:</p>
                <code class="raw-output">"{lastRawText}"</code>
            {/if}
            {#if errorMessage}
                <p class="error-msg">{errorMessage}</p>
            {/if}
        </div>
    {/if}
</div>

<style>
    .ocr-container { width: 100%; max-width: 500px; margin: auto; }
    .video-wrapper { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: cover; }
    .scan-overlay { position: absolute; left: 10%; top: 5%; width: 80%; height: 38%; border: 3px solid #00ff88; border-radius: 8px; pointer-events: none; box-shadow: 0 0 0 9999px rgba(0,0,0,0.5); }
    .controls-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.8); }
    .actions { margin-top: 1rem; }
    .main-btn { width: 100%; padding: 14px; background: #6366f1; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
    
    /* Debug Styling */
    .debug-panel { margin-top: 1rem; padding: 10px; background: #f4f4f5; border-radius: 8px; border: 1px solid #e4e4e7; min-height: 60px; }
    .raw-label { font-size: 0.7rem; color: #71717a; text-transform: uppercase; margin: 0; }
    .raw-output { display: block; font-family: monospace; color: #18181b; font-size: 1.1rem; padding: 4px 0; }
    .error-msg { color: #dc2626; font-size: 0.9rem; margin-top: 4px; font-weight: 500; }
</style>