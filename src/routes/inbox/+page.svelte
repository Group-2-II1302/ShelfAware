<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { invalidate } from '$app/navigation'
  import { enhance } from '$app/forms'
  import { fly, slide } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import { quintOut } from 'svelte/easing'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  type Notification = PageData['notifications'][number]

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
        <li
          class="inbox-item"
          class:inbox-item--unread={!n.readAt}
          in:fly|global={{
            y: -8,
            duration: mounted ? 280 : 0,
            easing: quintOut,
          }}
          out:slide={{ duration: 220, easing: quintOut }}
          animate:flip={{ duration: 320, easing: quintOut }}
        >
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
              <span class="inbox-item__dot" aria-hidden="true"></span>
              <span class="inbox-item__body">
                <span class="inbox-item__message">{n.message}</span>
                <span class="inbox-item__meta">
                  <span class="inbox-item__type">{n.alertType}</span>
                  <span class="inbox-item__sep">·</span>
                  <span class="inbox-item__time">
                    {formatRelative(n.lastTriggeredAt, now)}
                  </span>
                </span>
              </span>
            </button>
          </form>
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
    border-radius: 4px;
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

  .inbox-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  .inbox-item--unread {
    border-left: 3px solid var(--accent);
  }

  .inbox-item--unread .inbox-item__dot {
    background: var(--accent);
  }

  .inbox-item--unread .inbox-item__message {
    font-weight: 600;
  }

  .inbox-item__btn {
    width: 100%;
    background: transparent;
    border: none;
    padding: 0.85rem 1rem;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
  }

  .inbox-item__btn:hover {
    background: var(--background);
  }

  .inbox-item__dot {
    flex-shrink: 0;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: transparent;
    margin-top: 0.5rem;
  }

  .inbox-item__body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
    min-width: 0;
  }

  .inbox-item__message {
    line-height: 1.4;
    font-size: 0.95rem;
  }

  .inbox-item__meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.7rem;
    opacity: 0.55;
  }

  .inbox-item__type {
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }

  .inbox-item__sep {
    opacity: 0.6;
  }
</style>
