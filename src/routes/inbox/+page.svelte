<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { invalidate } from '$app/navigation'
  import { enhance } from '$app/forms'
  import { fly, slide } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import { quintOut } from 'svelte/easing'
  import {
    IconAlertOctagon,
    IconAlertTriangle,
    IconBellRinging,
  } from '@tabler/icons-svelte'
  import type { PageData } from './$types'
  import { classifyAlert, shortAlertLabel } from '$lib/alertsUi'

  let { data }: { data: PageData } = $props()

  type Notification = PageData['notifications'][number]

  /*
    Bucket / label functions live in $lib/alertsUi so the inbox and
    the realtime toast share one source of truth for urgency colour
    and short label. Don't inline these here.
  */
  const classify = (n: Notification) => classifyAlert(n)
  const shortLabel = (n: Notification) => shortAlertLabel(n)

  /*
    Local mirror of the server-provided list so we can patch it from
    realtime payloads (cron inserts, mark-read updates, resolutions)
    without re-running the server load on every event.
  */
  let liveById = $state<Record<string, Notification>>({})

  $effect(() => {
    const incoming = data.notifications
    untrack(() => {
      const next: Record<string, Notification> = {}
      for (const n of incoming) {
        const existing = liveById[n.id]
        if (existing && existing.readAt && !n.readAt) {
          next[n.id] = { ...n, readAt: existing.readAt }
        } else {
          next[n.id] = n
        }
      }
      liveById = next
    })
  })

  let now = $state(Date.now())
  let tick: ReturnType<typeof setInterval> | undefined
  let mounted = $state(false)
  onMount(() => {
    tick = setInterval(() => (now = Date.now()), 15_000)
    /*
      Defer enabling entry transitions by one tick so the initial
      list doesn't fly in on first paint — only newly-arriving rows
      after mount should animate.
    */
    queueMicrotask(() => (mounted = true))
  })

  const list = $derived(
    Object.values(liveById).sort((a, b) => {
      const at = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
      const bt = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
      return bt - at
    }),
  )

  const unreadCount = $derived(list.filter((n) => !n.readAt).length)

  function formatRelative(dateStr: string | null, nowMs: number) {
    if (!dateStr) return ''
    const delta = Math.floor((nowMs - new Date(dateStr).getTime()) / 1000)
    if (delta < 60) return 'just now'
    const mins = Math.floor(delta / 60)
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago'
    const hours = Math.floor(mins / 60)
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago'
    return new Date(dateStr).toLocaleDateString()
  }

  let invalidateTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleRefresh() {
    if (invalidateTimer) return
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined
      invalidate('app:alerts')
    }, 30_000)
  }

  let channel: ReturnType<typeof data.supabase.channel> | undefined

  onMount(() => {
    channel = data.supabase
      .channel('inbox-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts' },
        (payload) => {
          const row = payload.new as {
            id: string
            resolved_at: string | null
          }
          if (row.resolved_at) return
          /*
            New row from cron — we don't have the joined product info
            yet, so fall back to a refresh. Cheap because it only fires
            when an alert actually appears.
          */
          scheduleRefresh()
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
          const existing = liveById[row.id]
          if (!existing) return
          if (row.resolved_at) {
            const { [row.id]: _, ...rest } = liveById
            liveById = rest
            return
          }
          if (row.read_at !== existing.readAt) {
            liveById = {
              ...liveById,
              [row.id]: { ...existing, readAt: row.read_at },
            }
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'alerts' },
        (payload) => {
          const old = payload.old as { id?: string }
          if (!old?.id || !(old.id in liveById)) return
          const { [old.id]: _, ...rest } = liveById
          liveById = rest
        },
      )
      .subscribe()
  })

  onDestroy(() => {
    if (tick) clearInterval(tick)
    if (invalidateTimer) clearTimeout(invalidateTimer)
    if (channel) channel.unsubscribe()
  })

  function markReadLocal(id: string) {
    const existing = liveById[id]
    if (!existing || existing.readAt) return
    liveById = {
      ...liveById,
      [id]: { ...existing, readAt: new Date().toISOString() },
    }
  }

  /*
    Fire-and-forget "mark this read" used when the user navigates to
    the linked item. We update the local store immediately for the
    snappy UI response, then POST in the background so the badge /
    realtime listeners settle. Errors are non-fatal — the cron and
    auto-resolve logic will eventually reconcile.
  */
  async function markReadRemote(id: string) {
    try {
      const body = new FormData()
      body.append('id', id)
      await fetch('?/markRead', {
        method: 'POST',
        body,
        headers: { 'x-sveltekit-action': 'true' },
        keepalive: true,
      })
    } catch {
      /* ignore — local store already reflects the change */
    }
  }

  /**
   * Build the deep-link target for a notification. Returns null when
   * the alert is orphaned (no shelf / slot context), so the UI can
   * fall back to a non-clickable row.
   */
  function itemHref(n: Notification): string | null {
    if (!n.shelfId || n.scaleIndex === null || n.scaleIndex === undefined) {
      return null
    }
    return `/shelves/${encodeURIComponent(n.shelfId)}#slot-${n.scaleIndex}`
  }

  function handleItemClick(n: Notification) {
    /*
      Optimistic mark-read on click. Even if the row was already read
      we still navigate; the markReadRemote call short-circuits via
      markReadLocal's `if (existing.readAt) return` guard.
    */
    if (!n.readAt) {
      markReadLocal(n.id)
      void markReadRemote(n.id)
    }
  }
</script>

<svelte:head>
  <title>inbox · shelfAware</title>
</svelte:head>

<main class="inbox">
  <header class="inbox__header">
    <button
      type="button"
      class="inbox__back"
      onclick={() => history.back()}
      aria-label="Go back"
    >
      ←
    </button>
    <h1>Inbox</h1>
    {#if unreadCount > 0}
      <form
        method="POST"
        action="?/markAllRead"
        use:enhance={() => {
          for (const id of Object.keys(liveById)) markReadLocal(id)
          return async ({ update }) => {
            await update({ reset: false })
          }
        }}
      >
        <button type="submit" class="inbox__mark-all">Mark all read</button>
      </form>
    {/if}
  </header>

  {#if list.length === 0}
    <p class="inbox__empty">You're all caught up.</p>
  {:else}
    <ul class="inbox__list">
      {#each list as n (n.id)}
        {@const u = classify(n)}
        {@const href = itemHref(n)}
        <li
          class="inbox-item inbox-item--{u}"
          class:inbox-item--unread={!n.readAt}
          in:fly|global={{
            y: -8,
            duration: mounted ? 280 : 0,
            easing: quintOut,
          }}
          out:slide={{ duration: 220, easing: quintOut }}
          animate:flip={{ duration: 320, easing: quintOut }}
        >
          {#if href}
            <!--
              Anchor instead of a form so the row deep-links to the
              item on the shelf page (read or unread). Mark-read is
              done as a fire-and-forget side effect via fetch in the
              click handler, so navigation isn't blocked by it.
            -->
            <a
              class="inbox-item__btn"
              {href}
              onclick={() => handleItemClick(n)}
            >
              <span class="inbox-item__icon" aria-hidden="true">
                {#if u === 'crit'}
                  <IconAlertOctagon size={20} stroke={2} />
                {:else if u === 'warn'}
                  <IconAlertTriangle size={20} stroke={2} />
                {:else}
                  <IconBellRinging size={20} stroke={2} />
                {/if}
              </span>
              <span class="inbox-item__body">
                <span class="inbox-item__message">{n.message}</span>
                <span class="inbox-item__meta">
                  <span class="inbox-item__type">{shortLabel(n)}</span>
                  <span class="inbox-item__sep">·</span>
                  <span class="inbox-item__time">
                    {formatRelative(n.lastTriggeredAt, now)}
                  </span>
                </span>
              </span>
              {#if !n.readAt}
                <span class="inbox-item__dot" aria-label="Unread"></span>
              {/if}
            </a>
          {:else}
            <!--
              Orphaned alert (item was deleted) — fall back to the old
              mark-read-only form so the user can still clear it.
            -->
            <form
              method="POST"
              action="?/markRead"
              use:enhance={() => {
                markReadLocal(n.id)
                return async ({ update }) => {
                  await update({ reset: false })
                }
              }}
            >
              <input type="hidden" name="id" value={n.id} />
              <button type="submit" class="inbox-item__btn">
                <span class="inbox-item__icon" aria-hidden="true">
                  {#if u === 'crit'}
                    <IconAlertOctagon size={20} stroke={2} />
                  {:else if u === 'warn'}
                    <IconAlertTriangle size={20} stroke={2} />
                  {:else}
                    <IconBellRinging size={20} stroke={2} />
                  {/if}
                </span>
                <span class="inbox-item__body">
                  <span class="inbox-item__message">{n.message}</span>
                  <span class="inbox-item__meta">
                    <span class="inbox-item__type">{shortLabel(n)}</span>
                    <span class="inbox-item__sep">·</span>
                    <span class="inbox-item__time">
                      {formatRelative(n.lastTriggeredAt, now)}
                    </span>
                  </span>
                </span>
                {#if !n.readAt}
                  <span class="inbox-item__dot" aria-label="Unread"></span>
                {/if}
              </button>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .inbox {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 8rem;
  }

  .inbox__header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .inbox__header h1 {
    flex: 1;
    margin: 0;
    font-size: 1.4rem;
    font-weight: 500;
  }

  .inbox__back {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: 2.25rem;
    height: 2.25rem;
    font: inherit;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }

  .inbox__back:hover {
    background: var(--background);
  }

  .inbox__mark-all {
    background: transparent;
    border: none;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    text-decoration: underline;
    text-underline-offset: 3px;
    opacity: 0.75;
  }

  .inbox__mark-all:hover {
    opacity: 1;
  }

  .inbox__empty {
    text-align: center;
    padding: 3rem 1rem;
    opacity: 0.6;
    font-size: 0.9rem;
  }

  .inbox__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /*
    Each item carries an urgency-coloured icon + left accent stripe.
    Unread items get a soft tinted background so they stand out at a
    glance, and an unread dot on the right to mirror common chat /
    mail patterns. The palette intentionally matches the dashboard
    tile badges and folder micro-cells for visual cohesion.
  */
  .inbox-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  .inbox-item--crit {
    --inbox-accent: var(--error, #c0392b);
    --inbox-tint: rgba(192, 57, 43, 0.07);
  }
  .inbox-item--warn {
    --inbox-accent: var(--warn, #d39e3a);
    --inbox-tint: rgba(211, 158, 58, 0.09);
  }
  .inbox-item--ok {
    --inbox-accent: var(--matcha, #84a98c);
    --inbox-tint: rgba(132, 169, 140, 0.1);
  }

  .inbox-item--unread {
    background: var(--inbox-tint);
    border-left: 3px solid var(--inbox-accent);
  }

  .inbox-item--unread .inbox-item__message {
    font-weight: 600;
  }

  .inbox-item__btn {
    width: 100%;
    background: transparent;
    border: none;
    padding: 0.75rem 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    /*
      Reset anchor defaults so an `<a>` rendered with this class
      reads identically to the `<button>` variant used for orphaned
      alerts.
    */
    text-decoration: none;
    box-sizing: border-box;
  }

  .inbox-item__btn:hover {
    background: rgba(51, 42, 38, 0.03);
  }

  /*
    Coloured icon chip — fills with the accent for unread items
    (loud), softens to a tinted background with the accent as the
    glyph colour for read items (quiet). Keeps the page from looking
    like a wall of red even when there's a backlog.
  */
  .inbox-item__icon {
    flex-shrink: 0;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--inbox-tint);
    color: var(--inbox-accent);
    transition:
      background 0.15s,
      color 0.15s;
  }

  .inbox-item--unread .inbox-item__icon {
    background: var(--inbox-accent);
    color: #fff;
  }

  .inbox-item__body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1;
    min-width: 0;
  }

  .inbox-item__message {
    line-height: 1.35;
    font-size: 0.95rem;
  }

  .inbox-item__meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    opacity: 0.6;
  }

  .inbox-item__type {
    color: var(--inbox-accent);
    font-weight: 600;
    opacity: 0.85;
    text-transform: none;
    letter-spacing: 0;
  }

  .inbox-item__sep {
    opacity: 0.6;
  }

  /*
    Unread dot at the right edge — small, accent-coloured, the
    classic "you haven't seen this" affordance. Hidden once read.
  */
  .inbox-item__dot {
    flex-shrink: 0;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--inbox-accent);
    margin-left: 0.25rem;
  }
</style>
