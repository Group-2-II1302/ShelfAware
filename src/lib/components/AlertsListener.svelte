<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { page } from '$app/stores'
  import { goto } from '$app/navigation'
  import { fly, fade } from 'svelte/transition'
  import {
    IconAlertOctagon,
    IconAlertTriangle,
    IconBellRinging,
  } from '@tabler/icons-svelte'
  import type { SupabaseClient } from '@supabase/supabase-js'
  import { unreadAlerts } from '$lib/stores/alerts.svelte'
  import {
    classifyAlert,
    shortAlertLabel,
    type AlertUrgency,
  } from '$lib/alertsUi'

  type Toast = {
    id: string
    message: string
    label: string
    urgency: AlertUrgency
    /**
     * Deep-link to the offending item. Null when the alert's
     * shelf_items row was already gone at fetch time, in which case
     * tapping the toast falls back to the inbox.
     */
    href: string | null
  }

  const TOAST_DURATION_MS = 6000

  let { supabase, initialUnread }: {
    supabase: SupabaseClient
    initialUnread: number
  } = $props()

  let toasts = $state<Toast[]>([])

  $effect(() => {
    unreadAlerts.set(initialUnread)
  })

  /*
    When a new alert row appears we don't yet have the joined product
    info, so do a small follow-up fetch for just that row. Cheap and
    keeps the realtime payload size small.
  */
  async function fetchAlertDetail(id: string) {
    const { data } = await supabase
      .from('alerts')
      .select(
        'id, alert_type, last_triggered_at, shelf_items(shelf_id, scale_index, barcode, expiry_date, product_catalog(product_name))',
      )
      .eq('id', id)
      .maybeSingle()
    return data
  }

  /**
   * Build the same per-alert presentation pieces the inbox uses:
   * a human message, a short category label, and an urgency bucket.
   * Mirrors src/routes/inbox/+page.server.ts::formatMessage so toast
   * copy and inbox copy stay aligned.
   */
  function buildPresentation(row: any): {
    message: string
    label: string
    urgency: AlertUrgency
    href: string | null
  } {
    const shelf = Array.isArray(row.shelf_items)
      ? row.shelf_items[0]
      : row.shelf_items
    const product = shelf
      ? Array.isArray(shelf.product_catalog)
        ? shelf.product_catalog[0]
        : shelf.product_catalog
      : null
    const name = product?.product_name || shelf?.barcode || 'Item'

    let daysToExpiry: number | null = null
    if (shelf?.expiry_date) {
      const today = new Date(new Date().toISOString().split('T')[0]).getTime()
      daysToExpiry = Math.ceil(
        (new Date(shelf.expiry_date).getTime() - today) / 86400000,
      )
    }

    const classifyInput = { alertType: row.alert_type, daysToExpiry }
    const urgency = classifyAlert(classifyInput)
    const label = shortAlertLabel(classifyInput)

    let message = name
    if (row.alert_type === 'LOWSTOCK') {
      message = name + ' is running low'
    } else if (daysToExpiry !== null) {
      const status =
        daysToExpiry < 0
          ? 'expired ' +
            Math.abs(daysToExpiry) +
            ' day' +
            (Math.abs(daysToExpiry) === 1 ? '' : 's') +
            ' ago'
          : daysToExpiry === 0
            ? 'expires today'
            : 'expires in ' +
              daysToExpiry +
              ' day' +
              (daysToExpiry === 1 ? '' : 's')
      message = name + ' ' + status
    }

    /*
      Deep-link to the slot if we know it; otherwise null and the
      toast click handler falls back to /inbox.
    */
    const href =
      shelf?.shelf_id && shelf?.scale_index !== null && shelf?.scale_index !== undefined
        ? `/shelves/${encodeURIComponent(shelf.shelf_id)}#slot-${shelf.scale_index}`
        : null

    return { message, label, urgency, href }
  }

  function pushToast(toast: Toast) {
    toasts = [...toasts, toast]
  }

  function dismissToast(id: string) {
    toasts = toasts.filter((x) => x.id !== id)
  }

  /**
   * Mark an alert as read in the background. Used when the user
   * taps the toast — we want the badge to drop and the inbox to
   * reflect the action without the navigation waiting on it.
   */
  async function markReadRemote(id: string) {
    try {
      const body = new FormData()
      body.append('id', id)
      await fetch('/inbox?/markRead', {
        method: 'POST',
        body,
        headers: { 'x-sveltekit-action': 'true' },
        keepalive: true,
      })
    } catch {
      /* non-fatal — realtime UPDATE will reconcile or cron will retry */
    }
  }

  function openToast(t: Toast) {
    dismissToast(t.id)
    void markReadRemote(t.id)
    goto(t.href ?? '/inbox')
  }

  let channel: ReturnType<typeof supabase.channel> | undefined

  onMount(() => {
    channel = supabase
      .channel('alerts-global')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts' },
        async (payload) => {
          const row = payload.new as {
            id: string
            resolved_at: string | null
            read_at: string | null
          }
          if (row.resolved_at || row.read_at) return

          unreadAlerts.increment()

          /*
            Suppress the toast if the user is already on /inbox —
            the inbox UI shows the alert directly.
          */
          if ($page.url.pathname === '/inbox') return

          const detail = await fetchAlertDetail(row.id)
          if (!detail) return
          const { message, label, urgency, href } = buildPresentation(detail)
          pushToast({ id: row.id, message, label, urgency, href })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'alerts' },
        (payload) => {
          const row = payload.new as {
            id: string
            read_at: string | null
            resolved_at: string | null
          }
          const old = payload.old as {
            read_at?: string | null
            resolved_at?: string | null
          }

          /*
            Decrement when an alert that was unread+unresolved
            transitions out of that state (either marked read or
            resolved).
          */
          const wasUnread = !old?.read_at && !old?.resolved_at
          const nowCounted = !row.read_at && !row.resolved_at
          if (wasUnread && !nowCounted) {
            unreadAlerts.decrement()
            dismissToast(row.id)
          } else if (!wasUnread && nowCounted) {
            unreadAlerts.increment()
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'alerts' },
        (payload) => {
          /*
            DELETE payload.old only has full columns when the table
            has REPLICA IDENTITY FULL. With the default we still get
            the id, so we can always dismiss any visible toast for
            this alert. We only decrement the badge when we know the
            row was unread+unresolved.
          */
          const old = payload.old as {
            id?: string
            read_at?: string | null
            resolved_at?: string | null
          }
          if (!old?.id) return
          dismissToast(old.id)
          const wasUnread = !old.read_at && !old.resolved_at
          if (wasUnread) unreadAlerts.decrement()
        },
      )
      .subscribe()
  })

  onDestroy(() => {
    if (channel) channel.unsubscribe()
  })
</script>

<div class="toast-stack" aria-live="polite" aria-atomic="false">
  {#each toasts as t (t.id)}
    <!--
      Mirror the inbox-item visual language so the realtime toast
      reads as the same notification surface: accent stripe + tinted
      background + icon chip + accent label. Urgency drives every
      colour token via .toast--{urgency}.
    -->
    <div
      class="toast toast--{t.urgency}"
      role="status"
      in:fly={{ y: -16, duration: 220 }}
      out:fade={{ duration: 160 }}
    >
      <button
        type="button"
        class="toast__main"
        onclick={() => openToast(t)}
      >
        <span class="toast__icon" aria-hidden="true">
          {#if t.urgency === 'crit'}
            <IconAlertOctagon size={20} stroke={2} />
          {:else if t.urgency === 'warn'}
            <IconAlertTriangle size={20} stroke={2} />
          {:else}
            <IconBellRinging size={20} stroke={2} />
          {/if}
        </span>
        <span class="toast__body">
          <span class="toast__message">{t.message}</span>
          <span class="toast__meta">
            <span class="toast__label">{t.label}</span>
            <span class="toast__sep">·</span>
            <span class="toast__time">just now</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        class="toast__close"
        aria-label="Dismiss"
        onclick={() => dismissToast(t.id)}
      >
        ×
      </button>
      <div
        class="toast__bar"
        style="animation-duration: {TOAST_DURATION_MS}ms;"
        onanimationend={() => dismissToast(t.id)}
        aria-hidden="true"
      ></div>
    </div>
  {/each}
</div>

<style>
  .toast-stack {
    position: fixed;
    top: 1rem;
    right: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    z-index: 1000;
    max-width: calc(100vw - 2rem);
    width: 340px;
    pointer-events: none;
  }

  /*
    Same urgency palette as inbox-item — defined as CSS custom props
    so the icon chip, accent stripe, label colour, and tinted bg can
    all reference one variable per toast. Keep these colour values in
    sync with src/routes/inbox/+page.svelte (.inbox-item--*).
  */
  .toast {
    pointer-events: auto;
    position: relative;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    display: flex;
    align-items: stretch;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  }

  .toast--crit {
    --toast-accent: var(--error, #c0392b);
    --toast-tint: rgba(192, 57, 43, 0.07);
  }
  .toast--warn {
    --toast-accent: var(--warn, #d39e3a);
    --toast-tint: rgba(211, 158, 58, 0.09);
  }
  .toast--ok {
    --toast-accent: var(--matcha, #84a98c);
    --toast-tint: rgba(132, 169, 140, 0.1);
  }

  .toast {
    /*
      Stack the urgency tint on top of a solid --surface fill so the
      toast is fully opaque (nothing bleeds through while the page
      scrolls underneath) while still reading as a tinted card. Pure
      `var(--toast-tint)` is rgba(...) and would let the page show.
    */
    background:
      linear-gradient(var(--toast-tint), var(--toast-tint)),
      var(--surface);
    border-left: 3px solid var(--toast-accent);
  }

  .toast:hover .toast__bar,
  .toast:focus-within .toast__bar {
    animation-play-state: paused;
  }

  .toast__main {
    flex: 1;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    padding: 0.75rem 0.6rem 0.75rem 0.85rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font: inherit;
    min-width: 0;
  }

  .toast__main:hover {
    background: rgba(51, 42, 38, 0.03);
  }

  /*
    Filled accent chip — same visual treatment as the inbox-item's
    unread icon (loud) since toasts are by definition unread/new.
  */
  .toast__icon {
    flex-shrink: 0;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--toast-accent);
    color: #fff;
  }

  .toast__body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1;
    min-width: 0;
  }

  .toast__message {
    line-height: 1.35;
    font-size: 0.95rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .toast__meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    opacity: 0.6;
  }

  .toast__label {
    color: var(--toast-accent);
    font-weight: 600;
    opacity: 0.9;
  }

  .toast__sep {
    opacity: 0.6;
  }

  .toast__close {
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text);
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.75rem;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.15s, background 0.15s;
    flex-shrink: 0;
  }

  .toast__close:hover {
    opacity: 1;
    background: rgba(51, 42, 38, 0.04);
  }

  /*
    Slim countdown bar pinned to the bottom edge of the toast,
    coloured with the urgency accent so it doesn't fight the rest
    of the palette. Pauses on hover/focus (rule above).
  */
  .toast__bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--toast-accent);
    transform-origin: left center;
    animation-name: toast-countdown;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
    opacity: 0.85;
  }

  @keyframes toast-countdown {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast__bar {
      animation-duration: 8000ms !important;
    }
  }
</style>
