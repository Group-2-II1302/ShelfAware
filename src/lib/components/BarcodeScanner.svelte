    <script lang="ts">
        import { onMount, onDestroy } from 'svelte';
        import { Html5Qrcode } from 'html5-qrcode';

        // Export the interface so +page.svelte can see exactly what it needs to provide
        export interface ScannerProps {
            onscan: (barcode: string) => void | Promise<void>;
        }

        let { onscan }: ScannerProps = $props();
        
        let scanner: Html5Qrcode | null = null;
        
        // Explicitly typing the state to avoid "used before assigned"
        let readerElement = $state<HTMLElement | undefined>(undefined);
        
        // ====== UI + state flags ======
        // We manage these ourselves instead of relying on library internals
        let isStarted = $state(false);         // camera is currently running
        let isInitializing = $state(false);    // prevents double start clicks
        let stopping = $state(false);          // prevents overlapping stop calls
        let handled = $state(false);           // ensures we only process one scan per session
        let errorMessage = $state<string | null>(null);

        async function startScanner() {
            // Prevent weird edge cases: double start / stop in progress / re-entry
            if (isStarted || isInitializing || stopping) return;
            
            isInitializing = true;
            errorMessage = null;

            // reset scan guard every time we start fresh
            handled = false;

            try {
                // Create scanner instance only once
                if (!scanner && readerElement) {
                    scanner = new Html5Qrcode(readerElement.id || "reader-element");
                }

                if (scanner) {
                    // Start camera + scanning loop
                    await scanner.start(
                        { facingMode: "environment" }, // use back camera on mobile
                        {
                            fps: 10,
                            qrbox: { width: 250, height: 150 },
                            aspectRatio: 1.777778
                        },
                        onScanSuccess,
                        onScanFailure
                    );
                    isStarted = true;
                }
            } catch (err: any) {
                console.error("Scanner Start Error:", err);
                parseError(err);
                isStarted = false;
            } finally {
                isInitializing = false;
            }
        }

        function parseError(err: any) {
            const msg = err?.toString() || "";
            if (msg.includes("NotAllowedError") || msg.includes("Permission denied")) {
                errorMessage = "Camera permission denied.";
            } else if (msg.includes("NotFoundError")) {
                errorMessage = "No camera detected.";
            } else {
                errorMessage = "Could not access camera.";
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
                console.warn("Cleanup error:", err);
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

        function onScanFailure() {
            // Ignore noise
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
        <div id="reader-element" bind:this={readerElement} class="reader"></div>
        
        {#if !isStarted}
            <div class="overlay">
                {#if errorMessage}
                    <p class="error-msg">{errorMessage}</p>
                {/if}
                
                <button 
                    onclick={startScanner} 
                    disabled={isInitializing}
                    class="scan-button"
                >
                    {isInitializing ? 'Initialising...' : 'Start Scanner'}
                </button>
            </div>
        {/if}
    </div>

    <style>
        /* ... keep your original styles here ... */
        .scanner-container { position: relative; width: 100%; max-width: 500px; aspect-ratio: 16/9; margin: auto; background: #0a0a0a; border-radius: 12px; overflow: hidden; }
        .reader { width: 100%; height: 100%; }
        .scanner-container :global(video) { width: 100% !important; height: 100% !important; object-fit: cover !important; }
        .overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); padding: 20px; text-align: center; }
        .error-msg { color: #ff4d4d; margin-bottom: 1rem; font-size: 0.9rem; }
        .scan-button { padding: 12px 24px; background: #6366f1; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
        .scan-button:disabled { opacity: 0.5; }
    </style>