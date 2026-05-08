<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { page } from '$app/stores'
  import { goto } from '$app/navigation'
  import { fly, fade } from 'svelte/transition'
  import type { SupabaseClient } from '@supabase/supabase-js'
  import { unreadAlerts } from '$lib/stores/alerts.svelte'

  type Toast = {
    id: string
    title: string
    body: string
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
        'id, alert_type, last_triggered_at, shelf_items(barcode, expiry_date, product_catalog(product_name))',
      )
      .eq('id', id)
      .maybeSingle()
    return data
  }

  function buildMessage(row: any) {
    const shelf = Array.isArray(row.shelf_items)
      ? row.shelf_items[0]
      : row.shelf_items
    if (!shelf) return { title: row.alert_type, body: '' }

    const product = Array.isArray(shelf.product_catalog)
      ? shelf.product_catalog[0]
      : shelf.product_catalog
    const name = product?.product_name || shelf.barcode || 'Item'

    if (row.alert_type === 'LOWSTOCK') {
      return { title: 'Running low', body: name + ' is running low' }
    }

    if (!shelf.expiry_date) return { title: 'Expiring soon', body: name }

    const today = new Date(new Date().toISOString().split('T')[0]).getTime()
    const diff = Math.ceil(
      (new Date(shelf.expiry_date).getTime() - today) / 86400000,
    )
    const status =
      diff < 0
        ? 'has expired'
        : diff === 0
          ? 'expires today'
          : 'expires in ' + diff + ' day' + (diff === 1 ? '' : 's')
    return { title: 'Expiry alert', body: name + ' ' + status }
  }

  function pushToast(id: string, title: string, body: string) {
    toasts = [...toasts, { id, title, body }]
  }

  function dismissToast(id: string) {
    toasts = toasts.filter((x) => x.id !== id)
  }

  function openInbox(id: string) {
    dismissToast(id)
    goto('/inbox')
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
          const { title, body } = buildMessage(detail)
          pushToast(row.id, title, body)
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
      .subscribe()
  })

  onDestroy(() => {
    if (channel) channel.unsubscribe()
  })
</script>

<div class="toast-stack" aria-live="polite" aria-atomic="false">
  {#each toasts as t (t.id)}
    <div
      class="toast"
      role="status"
      in:fly={{ y: -16, duration: 220 }}
      out:fade={{ duration: 160 }}
    >
      <div class="toast__row">
        <button
          type="button"
          class="toast__main"
          onclick={() => openInbox(t.id)}
        >
          <span class="toast__title">{t.title}</span>
          <span class="toast__body">{t.body}</span>
        </button>
        <button
          type="button"
          class="toast__close"
          aria-label="Dismiss"
          onclick={() => dismissToast(t.id)}
        >
          ×
        </button>
      </div>
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
    width: 320px;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    overflow: hidden;
    font-family: 'Cascadia Mono', monospace;
  }

  .toast:hover .toast__bar,
  .toast:focus-within .toast__bar {
    animation-play-state: paused;
  }

  .toast__row {
    display: flex;
    align-items: stretch;
  }

  .toast__bar {
    height: 2px;
    background: var(--accent);
    transform-origin: left center;
    animation-name: toast-countdown;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
    opacity: 0.55;
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

  .toast__main {
    flex: 1;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    padding: 0.65rem 0.5rem 0.7rem 0.85rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font: inherit;
  }

  .toast__main:hover {
    background: var(--background);
  }

  .toast__title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.65;
  }

  .toast__body {
    font-size: 0.9rem;
    line-height: 1.35;
  }

  .toast__close {
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text);
    font-family: 'Cascadia Mono', monospace;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.75rem;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.15s, background 0.15s;
  }

  .toast__close:hover {
    opacity: 1;
    background: var(--background);
  }
</style>
