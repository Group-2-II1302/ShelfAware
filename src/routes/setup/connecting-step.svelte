<script lang="ts">
    import {
        IconDeviceMobile,
        IconWifi,
        IconWifiOff,
        IconAlertTriangle,
    } from "@tabler/icons-svelte";
    import { onMount, onDestroy } from "svelte";

    let {
        onCancel,
        offline = false,
        warning = null,
    } = $props<{
        onCancel: () => void;
        offline?: boolean;
        warning?: string | null;
    }>();

    // Cycle through reassuring status captions so the user knows we're alive.
    const captions = [
        "Watching for your device…",
        "Waiting for the first heartbeat…",
        "Almost there — hang tight…",
        "Still listening — your device should appear soon…",
    ];
    let captionIdx = $state(0);
    let elapsed = $state(0);

    let captionTimer: ReturnType<typeof setInterval> | null = null;
    let elapsedTimer: ReturnType<typeof setInterval> | null = null;

    onMount(() => {
        captionTimer = setInterval(() => {
            captionIdx = (captionIdx + 1) % captions.length;
        }, 8000);
        elapsedTimer = setInterval(() => {
            elapsed += 1;
        }, 1000);
    });

    onDestroy(() => {
        if (captionTimer) clearInterval(captionTimer);
        if (elapsedTimer) clearInterval(elapsedTimer);
    });

    function fmtElapsed(s: number): string {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${sec.toString().padStart(2, "0")}`;
    }
</script>

<div class="connecting">
    <div class="connecting__art" aria-hidden="true">
        <span class="pulse pulse--1"></span>
        <span class="pulse pulse--2"></span>
        <span class="pulse pulse--3"></span>
        <div class="device">
            <IconDeviceMobile size={44} stroke={1.5} />
        </div>
        <div class="signal">
            <IconWifi size={20} stroke={2} />
        </div>
    </div>

    <h2 class="connecting__title">Connecting your shelf…</h2>
    <p class="connecting__caption" aria-live="polite">
        {captions[captionIdx]}
    </p>

    <div class="connecting__meta">
        <span class="dot"></span>
        <span>Elapsed {fmtElapsed(elapsed)}</span>
        <span class="sep">·</span>
        <span>Usually 1–6 min</span>
    </div>

    {#if offline}
        <div class="banner banner--error" role="status">
            <IconWifiOff size={16} stroke={2} />
            <span>
                You're offline. We'll resume as soon as you're back on
                Wi-Fi.
            </span>
        </div>
    {:else if warning}
        <div class="banner banner--warn" role="status">
            <IconAlertTriangle size={16} stroke={2} />
            <span>{warning}</span>
        </div>
    {/if}

    <button type="button" class="cancel-btn" onclick={onCancel}>
        Cancel
    </button>
</div>

<style>
    .connecting {
        max-width: 440px;
        margin: 2.5rem auto;
        padding: 2rem 1.5rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        text-align: center;
        background: var(--surface);
        border-radius: var(--radius-lg);
        box-shadow: 0 2px 12px rgba(51, 42, 38, 0.06);
    }

    .connecting__art {
        position: relative;
        width: 160px;
        height: 160px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 0.25rem;
    }

    .pulse {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: var(--matcha-soft);
        opacity: 0.7;
        animation: pulse 2.4s ease-out infinite;
    }

    .pulse--2 {
        animation-delay: 0.8s;
    }

    .pulse--3 {
        animation-delay: 1.6s;
    }

    @keyframes pulse {
        0% {
            transform: scale(0.6);
            opacity: 0.7;
        }
        80% {
            opacity: 0;
        }
        100% {
            transform: scale(2.2);
            opacity: 0;
        }
    }

    .device {
        position: relative;
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: var(--matcha-soft);
        color: var(--matcha-deep);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(122, 139, 63, 0.25);
    }

    .device :global(svg) {
        color: var(--matcha-deep);
    }

    .signal {
        position: absolute;
        right: 18px;
        top: 22px;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--matcha);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: bob 1.8s ease-in-out infinite;
    }

    .signal :global(svg) {
        color: #fff;
    }

    @keyframes bob {
        0%,
        100% {
            transform: translateY(0);
        }
        50% {
            transform: translateY(-4px);
        }
    }

    .connecting__title {
        margin: 0.25rem 0 0;
        font-size: 1.25rem;
        font-weight: 600;
    }

    .connecting__caption {
        margin: 0;
        font-size: 0.95rem;
        opacity: 0.75;
        line-height: 1.4;
        min-height: 2.6em;
    }

    .connecting__meta {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.82rem;
        opacity: 0.6;
        margin-top: 0.25rem;
    }

    .sep {
        opacity: 0.6;
    }

    .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--matcha);
        animation: blink 1.4s ease-in-out infinite;
    }

    @keyframes blink {
        0%,
        100% {
            opacity: 0.3;
        }
        50% {
            opacity: 1;
        }
    }

    .banner {
        margin-top: 0.5rem;
        display: inline-flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.55rem 0.8rem;
        border-radius: var(--radius-sm);
        font-size: 0.85rem;
        line-height: 1.35;
        text-align: left;
        max-width: 22rem;
    }

    .banner--warn {
        background: var(--warn-soft);
        border-left: 3px solid var(--warn);
        color: var(--text);
    }

    .banner--warn :global(svg) {
        color: var(--warn);
        flex-shrink: 0;
        margin-top: 0.1rem;
    }

    .banner--error {
        background: #fbecec;
        border-left: 3px solid var(--error);
        color: var(--text);
    }

    .banner--error :global(svg) {
        color: var(--error);
        flex-shrink: 0;
        margin-top: 0.1rem;
    }

    .cancel-btn {
        margin-top: 0.75rem;
        background: transparent;
        border: 1px solid var(--matcha-soft);
        color: var(--text);
        padding: 0.5rem 1.2rem;
        font-size: 0.9rem;
        border-radius: var(--radius-pill);
        cursor: pointer;
        transition: background 0.15s ease;
    }

    .cancel-btn:hover {
        background: var(--matcha-soft);
    }
</style>
