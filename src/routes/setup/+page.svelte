<script lang="ts">
    import { setupState } from "../../lib/setup/stores";
    import ConnectingStep from "./connecting-step.svelte";
    import SuccessStep from "./success-step.svelte";
    import ErrorBanner from "../../lib/components/ErrorBanner.svelte";
    import { waitForNewShelf } from "$lib/setup/waitForNewShelf";
    import { BACKEND_URL } from "$lib/config";
    import { goto } from "$app/navigation";
    import { onMount, onDestroy } from "svelte";
    import {
        IconPlug,
        IconWifi,
        IconExternalLink,
        IconForms,
        IconCircleCheck,
        IconRefresh,
        IconCopy,
        IconCheck,
        IconId,
        IconAlertTriangle,
        IconWifiOff,
    } from "@tabler/icons-svelte";

    let { data } = $props<{ data: { userId: string } }>();

    let controller: AbortController | null = null;
    let deviceOpened = $state(false);
    let copied = $state(false);
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    let isOnline = $state(true);
    let checking = $state(false);
    let checkError = $state<string | null>(null);
    let waitingWarning = $state<string | null>(null);
    let consecutiveFailures = 0;

    /*
      Probe the backend before we navigate to the connecting screen.
      navigator.onLine can't tell us the user is stuck on the device
      hotspot (the OS still sees a Wi-Fi connection), so we attempt
      a real round-trip and fail fast with a friendly message.
    */
    async function checkBackendReachable(): Promise<boolean> {
        try {
            const res = await fetch(`${BACKEND_URL}/shelves`, {
                method: "HEAD",
                cache: "no-store",
                signal: AbortSignal.timeout(3500),
            });
            // Any response (including 401/404) proves we reached the host.
            return res.status < 500 || res.status >= 200;
        } catch {
            return false;
        }
    }

    function handleOnline() {
        isOnline = true;
        checkError = null;
    }
    function handleOffline() {
        isOnline = false;
    }

    async function copyUserId() {
        try {
            await navigator.clipboard.writeText(data.userId);
            copied = true;
            if (copyTimer) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => (copied = false), 1800);
        } catch (e) {
            console.error("Clipboard write failed", e);
            // Fallback: select the text so the user can copy manually.
            const el = document.getElementById("user-id-value");
            if (el) {
                const range = document.createRange();
                range.selectNodeContents(el);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
        }
    }

    /*
      The setup store lives at module scope, so navigating away
      mid-poll and coming back would otherwise leave the page stuck
      in "waiting" with no live poller behind it. Reset on mount
      so we always start from a clean idle state.
    */
    onMount(() => {
        setupState.set({ step: "idle", shelfId: undefined, error: undefined });
        if (typeof navigator !== "undefined") {
            isOnline = navigator.onLine;
            window.addEventListener("online", handleOnline);
            window.addEventListener("offline", handleOffline);
        }
    });

    async function startSetup() {
        if (checking) return;
        checkError = null;
        checking = true;

        const reachable = await checkBackendReachable();
        checking = false;

        if (!reachable) {
            checkError =
                "Couldn't reach ShelfAware. Make sure you've switched back to your home Wi-Fi, then try again.";
            return;
        }

        controller?.abort();
        controller = new AbortController();

        consecutiveFailures = 0;
        waitingWarning = null;

        setupState.set({
            step: "waiting",
            shelfId: undefined,
            error: undefined,
        });

        try {
            const shelfId = await waitForNewShelf(controller.signal, {
                onProgress: (outcome) => {
                    if (outcome === "ok") {
                        consecutiveFailures = 0;
                        waitingWarning = null;
                    } else {
                        consecutiveFailures += 1;
                        if (consecutiveFailures >= 3) {
                            waitingWarning =
                                "Still waiting. If you haven't switched back to your home Wi-Fi yet, do that now.";
                        }
                    }
                },
            });
            setupState.set({
                step: "success",
                shelfId,
                error: undefined,
            });
        } catch (e: any) {
            if (e.name === "AbortError") return;
            const friendly =
                e?.message === "Provisioning timed out"
                    ? "We didn't hear from your device in time. Make sure you're back on your home Wi-Fi, your device is powered on, and try again."
                    : e?.message ?? "Something went wrong while connecting.";
            setupState.set({
                step: "error",
                shelfId: undefined,
                error: friendly,
            });
        }
    }

    function cancelSetup() {
        controller?.abort();
        controller = null;
        setupState.set({ step: "idle", shelfId: undefined, error: undefined });
    }

    function handleOpenDevicePage() {
        deviceOpened = true;
    }

    function handleFinish() {
        if (!$setupState.shelfId) {
            console.error("Missing shelfId");
            return;
        }
        goto(`/shelves/${$setupState.shelfId}`);
    }

    onDestroy(() => {
        controller?.abort();
        if (copyTimer) clearTimeout(copyTimer);
        if (typeof window !== "undefined") {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        }
    });
</script>

{#if $setupState.step === "idle"}
    <div class="setup">
        <header class="setup__header">
            <div class="setup__header-row">
                <a class="setup__back" href="/" aria-label="Back to dashboard">
                    ←
                </a>
                <h1 class="setup__title">Set up your shelf</h1>
            </div>
            <p class="setup__subtitle">
                Follow these five quick steps to bring your device online.
                It only takes a couple of minutes.
            </p>
        </header>

        <ol class="stepper" aria-label="Setup steps">
            <li class="step">
                <div class="step__marker">
                    <span class="step__num">1</span>
                </div>
                <div class="step__body">
                    <div class="step__head">
                        <IconPlug size={20} stroke={1.75} />
                        <h2 class="step__title">Plug in your device</h2>
                    </div>
                    <p class="step__text">
                        Connect the ShelfAware device to a power source and
                        wait for its indicator light to turn on.
                    </p>
                </div>
            </li>

            <li class="step">
                <div class="step__marker">
                    <span class="step__num">2</span>
                </div>
                <div class="step__body">
                    <div class="step__head">
                        <IconId size={20} stroke={1.75} />
                        <h2 class="step__title">Copy your user ID</h2>
                    </div>
                    <p class="step__text">
                        The device page will ask for your user ID so it
                        knows which account to link to. Copy it now, while
                        you still have internet — you'll paste it on the
                        device page in a moment.
                    </p>
                    <button
                        type="button"
                        class="user-id"
                        class:user-id--copied={copied}
                        onclick={copyUserId}
                        aria-label="Copy user ID to clipboard"
                    >
                        <span class="user-id__value" id="user-id-value">
                            {data.userId}
                        </span>
                        <span class="user-id__action">
                            {#if copied}
                                <IconCheck size={16} stroke={2.25} />
                                Copied
                            {:else}
                                <IconCopy size={16} stroke={2} />
                                Copy
                            {/if}
                        </span>
                    </button>
                </div>
            </li>

            <li class="step">
                <div class="step__marker">
                    <span class="step__num">3</span>
                </div>
                <div class="step__body">
                    <div class="step__head">
                        <IconWifi size={20} stroke={1.75} />
                        <h2 class="step__title">Join its Wi-Fi hotspot</h2>
                    </div>
                    <p class="step__text">
                        On your phone or computer, open Wi-Fi settings and
                        connect to the network named
                        <code class="step__code">ShelfAware_setup</code>
                        using the password
                        <code class="step__code">shelfaware123</code>.
                    </p>
                    <div class="callout">
                        <IconAlertTriangle size={18} stroke={2} />
                        <div>
                            <strong>Heads up:</strong> your phone will lose
                            internet while on this hotspot. That's normal —
                            keep this tab open and <em>don't refresh it</em>.
                            You'll reconnect to your home Wi-Fi after step 5.
                        </div>
                    </div>
                </div>
            </li>

            <li class="step">
                <div class="step__marker">
                    <span class="step__num">4</span>
                </div>
                <div class="step__body">
                    <div class="step__head">
                        <IconExternalLink size={20} stroke={1.75} />
                        <h2 class="step__title">Open the device page</h2>
                    </div>
                    <p class="step__text">
                        This is where you'll tell the device which Wi-Fi to
                        use for everyday operation.
                    </p>
                    <a
                        class="step__link-btn"
                        href="http://192.168.4.1"
                        target="_blank"
                        rel="noopener noreferrer"
                        onclick={handleOpenDevicePage}
                    >
                        <IconExternalLink size={16} stroke={2} />
                        Open device page
                    </a>
                </div>
            </li>

            <li class="step">
                <div class="step__marker">
                    <span class="step__num">5</span>
                </div>
                <div class="step__body">
                    <div class="step__head">
                        <IconForms size={20} stroke={1.75} />
                        <h2 class="step__title">
                            Fill in your home Wi-Fi, then rejoin it
                        </h2>
                    </div>
                    <p class="step__text">
                        On the device page, enter your home Wi-Fi name and
                        password, then paste your user ID, and submit. The
                        device will reboot and join your network. Switch
                        your phone back to your home Wi-Fi before tapping
                        the button below.
                    </p>
                </div>
            </li>
        </ol>

        <div class="setup__cta">
            <button
                type="button"
                class="primary-btn"
                onclick={startSetup}
                disabled={!deviceOpened || !isOnline || checking}
            >
                {#if checking}
                    <span class="primary-btn__spinner" aria-hidden="true"
                    ></span>
                    Checking connection…
                {:else}
                    <IconCircleCheck size={18} stroke={2} />
                    I've finished — connect my shelf
                {/if}
            </button>
            {#if checkError}
                <p class="setup__hint setup__hint--warn" role="alert">
                    <IconWifiOff size={14} stroke={2} />
                    {checkError}
                </p>
            {:else if !isOnline}
                <p class="setup__hint setup__hint--warn">
                    <IconWifiOff size={14} stroke={2} />
                    You're offline — switch back to your home Wi-Fi to
                    continue.
                </p>
            {:else if !deviceOpened}
                <p class="setup__hint">
                    Open the device page in step 4 first to unlock this.
                </p>
            {:else}
                <p class="setup__hint">
                    We'll watch for your device to come online. This usually
                    takes 1–6 minutes.
                </p>
            {/if}
        </div>
    </div>
{:else if $setupState.step === "waiting"}
    <ConnectingStep
        onCancel={cancelSetup}
        offline={!isOnline}
        warning={waitingWarning}
    />
{:else if $setupState.step === "success"}
    <SuccessStep onFinish={handleFinish} />
{:else if $setupState.step === "error"}
    <div class="setup setup--error">
        {#if $setupState.error}
            <ErrorBanner message={$setupState.error} />
        {/if}
        <div class="setup__cta">
            <button type="button" class="primary-btn" onclick={startSetup}>
                <IconRefresh size={18} stroke={2} />
                Try again
            </button>
            <button type="button" class="ghost-btn" onclick={cancelSetup}>
                Back to instructions
            </button>
        </div>
    </div>
{/if}

<style>
    .setup {
        max-width: 640px;
        margin: 0 auto;
        padding: 1.5rem 1rem 5rem;
    }

    .setup__header {
        margin-bottom: 1.5rem;
    }

    .setup__header-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.4rem;
    }

    .setup__back {
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

    .setup__back:hover {
        background: var(--background);
    }

    .setup__title {
        font-size: 1.6rem;
        margin: 0;
        letter-spacing: -0.01em;
        flex: 1;
        min-width: 0;
    }

    .setup__subtitle {
        margin: 0;
        color: var(--text);
        opacity: 0.7;
        line-height: 1.4;
    }

    .stepper {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        position: relative;
    }

    .step {
        position: relative;
        display: grid;
        grid-template-columns: 2.25rem 1fr;
        gap: 0.85rem;
        background: var(--surface);
        border-radius: var(--radius-md);
        padding: 0.9rem 1rem 1rem;
        box-shadow: 0 1px 2px rgba(51, 42, 38, 0.04);
    }

    /* Connecting line behind the markers. */
    .step:not(:last-child)::after {
        content: "";
        position: absolute;
        left: calc(1rem + 1.125rem - 1px);
        top: calc(0.9rem + 2.25rem);
        bottom: -0.75rem;
        width: 2px;
        background: var(--matcha-soft);
        border-radius: 1px;
    }

    .step__marker {
        width: 2.25rem;
        height: 2.25rem;
        border-radius: 50%;
        background: var(--matcha-soft);
        color: var(--matcha-deep);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 0.95rem;
        flex-shrink: 0;
    }

    .step__num {
        line-height: 1;
    }

    .step__body {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }

    .step__head {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        color: var(--text);
    }

    .step__head :global(svg) {
        color: var(--matcha-deep);
        flex-shrink: 0;
    }

    .step__title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.25;
    }

    .step__text {
        margin: 0;
        font-size: 0.92rem;
        line-height: 1.45;
        opacity: 0.78;
    }

    .step__code {
        display: inline-block;
        background: var(--background);
        border: 1px solid var(--matcha-soft);
        border-radius: var(--radius-xs);
        padding: 0.05rem 0.4rem;
        font-size: 0.88rem;
        font-weight: 600;
    }

    .step__link-btn {
        align-self: flex-start;
        margin-top: 0.4rem;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.45rem 0.8rem;
        border-radius: var(--radius-pill);
        background: var(--background);
        color: var(--text);
        text-decoration: none;
        font-size: 0.88rem;
        font-weight: 600;
        border: 1px solid var(--matcha-soft);
        transition: background 0.15s ease, transform 0.05s ease;
    }

    .step__link-btn:hover {
        background: var(--matcha-soft);
    }

    .step__link-btn:active {
        transform: translateY(1px);
    }

    .callout {
        margin-top: 0.55rem;
        display: flex;
        gap: 0.55rem;
        padding: 0.6rem 0.75rem;
        background: var(--warn-soft);
        border-left: 3px solid var(--warn);
        border-radius: var(--radius-sm);
        font-size: 0.85rem;
        line-height: 1.4;
        color: var(--text);
    }

    .callout :global(svg) {
        color: var(--warn);
        flex-shrink: 0;
        margin-top: 0.1rem;
    }

    .callout strong {
        font-weight: 600;
    }

    .callout em {
        font-style: normal;
        font-weight: 600;
    }

    .user-id {
        align-self: stretch;
        margin-top: 0.5rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.55rem 0.65rem 0.55rem 0.85rem;
        background: var(--background);
        border: 1px solid var(--matcha-soft);
        border-radius: var(--radius-sm);
        cursor: pointer;
        text-align: left;
        font-family: inherit;
        transition: background 0.15s ease, border-color 0.15s ease;
    }

    .user-id:hover {
        background: var(--matcha-soft);
    }

    .user-id:active {
        transform: translateY(1px);
    }

    .user-id--copied {
        background: var(--matcha-soft);
        border-color: var(--matcha);
    }

    .user-id__value {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--text);
        opacity: 0.85;
        user-select: all;
    }

    .user-id__action {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.3rem 0.65rem;
        background: var(--surface);
        border-radius: var(--radius-pill);
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--matcha-deep);
    }

    .user-id__action :global(svg) {
        color: var(--matcha-deep);
    }

    .setup__cta {
        margin-top: 1.5rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.6rem;
    }

    .primary-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        background: var(--text);
        color: var(--background);
        border: none;
        border-radius: var(--radius-pill);
        padding: 0.8rem 1.4rem;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, transform 0.05s ease,
            opacity 0.15s ease;
    }

    .primary-btn :global(svg) {
        color: var(--background);
    }

    .primary-btn:hover:not(:disabled) {
        background: #1f1916;
    }

    .primary-btn:active:not(:disabled) {
        transform: translateY(1px);
    }

    .primary-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .primary-btn__spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(244, 241, 240, 0.35);
        border-top-color: var(--background);
        animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .ghost-btn {
        background: transparent;
        border: none;
        color: var(--text);
        opacity: 0.65;
        font-size: 0.9rem;
        cursor: pointer;
        padding: 0.4rem 0.8rem;
        border-radius: var(--radius-pill);
    }

    .ghost-btn:hover {
        opacity: 1;
        background: var(--matcha-soft);
    }

    .setup__hint {
        margin: 0;
        font-size: 0.85rem;
        opacity: 0.65;
        text-align: center;
        max-width: 22rem;
        line-height: 1.4;
    }

    .setup__hint--warn {
        opacity: 1;
        color: var(--warn);
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-weight: 600;
    }

    .setup__hint--warn :global(svg) {
        color: var(--warn);
    }

    .setup--error {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
</style>
