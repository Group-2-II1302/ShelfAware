<script lang="ts">
    import { IconCheck, IconArrowRight } from "@tabler/icons-svelte";

    let { onFinish } = $props<{ onFinish: () => void }>();

    function finish() {
        onFinish();
    }
</script>

<div class="success">
    <div class="success__art" aria-hidden="true">
        <span class="ring ring--1"></span>
        <span class="ring ring--2"></span>
        <div class="check">
            <IconCheck size={42} stroke={3} />
        </div>
    </div>

    <h2 class="success__title">Your shelf is online</h2>
    <p class="success__subtitle">
        Nicely done. Your device is connected and ready to start tracking
        what's on your shelf.
    </p>

    <button type="button" class="primary-btn" onclick={finish}>
        View your shelf
        <IconArrowRight size={18} stroke={2} />
    </button>
</div>

<style>
    .success {
        max-width: 440px;
        margin: 2.5rem auto;
        padding: 2rem 1.5rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.6rem;
        text-align: center;
        background: var(--surface);
        border-radius: var(--radius-lg);
        box-shadow: 0 2px 12px rgba(51, 42, 38, 0.06);
    }

    .success__art {
        position: relative;
        width: 140px;
        height: 140px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 0.25rem;
    }

    .ring {
        position: absolute;
        border-radius: 50%;
        border: 2px solid var(--matcha);
        opacity: 0;
        animation: ring-expand 1.6s ease-out forwards;
    }

    .ring--1 {
        width: 60px;
        height: 60px;
        animation-delay: 0.15s;
    }

    .ring--2 {
        width: 60px;
        height: 60px;
        animation-delay: 0.35s;
    }

    @keyframes ring-expand {
        0% {
            transform: scale(0.6);
            opacity: 0.8;
        }
        100% {
            transform: scale(2.4);
            opacity: 0;
        }
    }

    .check {
        position: relative;
        width: 88px;
        height: 88px;
        border-radius: 50%;
        background: var(--matcha);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 18px rgba(122, 139, 63, 0.35);
        transform: scale(0);
        animation: pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }

    .check :global(svg) {
        color: #fff;
    }

    @keyframes pop {
        0% {
            transform: scale(0);
        }
        70% {
            transform: scale(1.1);
        }
        100% {
            transform: scale(1);
        }
    }

    .success__title {
        margin: 0.5rem 0 0;
        font-size: 1.4rem;
        font-weight: 600;
        letter-spacing: -0.01em;
    }

    .success__subtitle {
        margin: 0;
        font-size: 0.95rem;
        opacity: 0.75;
        line-height: 1.45;
        max-width: 22rem;
    }

    .primary-btn {
        margin-top: 1rem;
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
        transition: background 0.15s ease, transform 0.05s ease;
    }

    .primary-btn :global(svg) {
        color: var(--background);
    }

    .primary-btn:hover {
        background: #1f1916;
    }

    .primary-btn:active {
        transform: translateY(1px);
    }
</style>
