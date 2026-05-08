<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import {
    bucketFromLastSeen,
    BUCKET_LABEL,
    formatRelative,
    type SyncBucket,
  } from '$lib/syncStatus'

  /**
   * Status pill summarising whether a shelf's hardware is reporting.
   * Re-evaluates the bucket and relative-time label every 15 s so a
   * shelf that was "Online · just now" smoothly ticks to "Idle · 3
   * min ago" even without any new realtime events.
   *
   * Pure presentational; the parent owns the `lastSeen` state and is
   * responsible for refreshing it (e.g. via Supabase realtime).
   */

  let {
    lastSeen,
    hasItems = true,
    compact = false,
  }: {
    lastSeen: string | Date | null | undefined
    /**
     * Whether the shelf currently has any items. Used to disambiguate
     * "no readings because the shelf is empty" from "no readings
     * because the device hasn't checked in yet". Defaults to true so
     * unset callers see the legacy behaviour (treat as awaiting).
     */
    hasItems?: boolean
    /**
     * Compact mode hides the "synced X ago" suffix and uses a smaller
     * footprint — useful in dense list views (e.g. shelves dashboard)
     * where the pill needs to coexist with other metadata.
     */
    compact?: boolean
  } = $props()

  /*
    Tick state. We bump this on a timer to force the $derived values
    below to recompute against a current `now`, so the relative-time
    label stays accurate even when no props change.
  */
  let now = $state(new Date())
  let intervalId: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    intervalId = setInterval(() => {
      now = new Date()
    }, 15_000)
  })

  onDestroy(() => {
    if (intervalId) clearInterval(intervalId)
  })

  const bucket = $derived<SyncBucket>(bucketFromLastSeen(lastSeen, now, hasItems))
  const relative = $derived(formatRelative(lastSeen, now))
  const label = $derived(BUCKET_LABEL[bucket])
</script>

<span
  class="sync-badge sync-badge--{bucket}"
  class:sync-badge--compact={compact}
  role="status"
  aria-label={`Sync status: ${label}${lastSeen ? `, last seen ${relative}` : ''}`}
  title={
    lastSeen
      ? `Last seen ${relative}`
      : hasItems
        ? 'Items present, but the device has not reported yet'
        : 'No items on this shelf yet'
  }
>
  <span class="sync-badge__dot" aria-hidden="true"></span>
  <span class="sync-badge__label">{label}</span>
  {#if !compact && lastSeen}
    <span class="sync-badge__time">· {relative}</span>
  {/if}
</span>

<style>
  .sync-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    font-size: 0.78rem;
    line-height: 1.2;
    font-weight: 500;
    background: var(--badge-bg, rgba(0, 0, 0, 0.05));
    color: var(--badge-fg, inherit);
    white-space: nowrap;
  }

  .sync-badge--compact {
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
  }

  .sync-badge__dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--badge-dot, currentColor);
  }

  .sync-badge__label {
    font-weight: 600;
  }

  .sync-badge__time {
    opacity: 0.75;
    font-weight: 400;
  }

  /* ── Bucket palettes ────────────────────────────────────────────────────── */

  .sync-badge--online {
    --badge-dot: #16a34a;
    --badge-fg: #166534;
    --badge-bg: #dcfce7;
  }

  .sync-badge--idle {
    --badge-dot: #ca8a04;
    --badge-fg: #854d0e;
    --badge-bg: #fef9c3;
  }

  .sync-badge--stale {
    --badge-dot: #ea580c;
    --badge-fg: #9a3412;
    --badge-bg: #ffedd5;
  }

  .sync-badge--offline {
    --badge-dot: #dc2626;
    --badge-fg: #991b1b;
    --badge-bg: #fee2e2;
  }

  .sync-badge--awaiting {
    --badge-dot: #6b7280;
    --badge-fg: #374151;
    --badge-bg: #e5e7eb;
  }

  .sync-badge--empty {
    --badge-dot: #9ca3af;
    --badge-fg: #4b5563;
    --badge-bg: #f3f4f6;
  }

  /*
    Subtle live pulse on the green dot so an "Online" badge feels
    alive without being distracting. Skipped for reduced-motion.
  */
  .sync-badge--online .sync-badge__dot {
    animation: sync-pulse 2.4s ease-in-out infinite;
  }

  @keyframes sync-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.5);
    }
    50% {
      box-shadow: 0 0 0 0.35rem rgba(22, 163, 74, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sync-badge--online .sync-badge__dot {
      animation: none;
    }
  }
</style>
