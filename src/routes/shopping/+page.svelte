<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { enhance } from '$app/forms'
  import { invalidate } from '$app/navigation'
  import { flip } from 'svelte/animate'
  import { fade, slide } from 'svelte/transition'
  import type { PageData } from './$types'
  import {
    IconShoppingCart,
    IconPlus,
    IconTrash,
    IconPencil,
    IconCheck,
    IconX,
    IconChevronUp,
    IconChevronDown,
    IconGripVertical,
    IconAlertTriangle,
    IconClock,
    IconPackage,
  } from '@tabler/icons-svelte'

  let { data }: { data: PageData } = $props()

  /*
    Local mirrors so realtime patches and optimistic mutations don't
    require a full server load. Initialised empty + populated by the
    effect below; we deliberately avoid reading data.items at module
    scope (Svelte 5 warns on `state_referenced_locally`, and resyncing
    via $effect is the pattern we want anyway).
  */
  let localItems = $state<typeof data.items>([])
  let localDismissals = $state(new Set<string>()) // realtime-only, optimistic

  $effect(() => {
    /*
      Pull in server-authoritative items whenever the load returns. We
      replace wholesale rather than diff: SvelteKit reruns the load on
      every successful action, so this stays in lock-step without us
      hand-maintaining a merge function.
    */
    localItems = [...data.items]
  })

  /*
    Suggestions visible to the user = server-derived suggestions minus
    anything we've optimistically promoted to the list locally and minus
    anything we've optimistically dismissed locally. Both sets are reset
    when the load returns (suggestion shape comes from the server, which
    has already applied dismissals + on-list dedup).
  */
  let optimisticAddedKeys = $state(new Set<string>())
  let optimisticDismissedKeys = $state(new Set<string>())

  $effect(() => {
    /*
      Whenever the server-load reruns it has already accounted for our
      mutations, so clear the optimistic overlays. Without this they'd
      pile up forever.
    */
    data.suggestions
    optimisticAddedKeys = new Set()
    optimisticDismissedKeys = new Set()
    localDismissals = new Set()
  })

  const visibleSuggestions = $derived(
    data.suggestions.filter((s) => {
      const key = s.sourceItemId + ':' + s.reason
      return (
        !optimisticAddedKeys.has(key) &&
        !optimisticDismissedKeys.has(key) &&
        !localDismissals.has(key)
      )
    }),
  )

  const uncheckedItems = $derived(
    localItems.filter((i) => i.checked_at === null),
  )
  const checkedItems = $derived(
    localItems.filter((i) => i.checked_at !== null),
  )

  /*
    Manual add form state. Kept inline at the top of the list rather
    than tucked away in a modal — adding things should be one tap.
  */
  let newName = $state('')
  let newQuantity = $state('')
  let newUnit = $state('')
  let addError = $state<string | null>(null)

  /*
    Per-row inline edit state. id of the row being edited (null when
    none); when set we replace the row's body with an inline form.
  */
  let editingId = $state<string | null>(null)
  let editName = $state('')
  let editQuantity = $state('')
  let editUnit = $state('')
  let editError = $state<string | null>(null)

  function startEdit(item: (typeof localItems)[number]) {
    editingId = item.id
    editName = item.name
    editQuantity = item.quantity === null ? '' : String(item.quantity)
    editUnit = item.unit ?? ''
    editError = null
  }
  function cancelEdit() {
    editingId = null
    editError = null
  }

  /*
    Local "checked" toggle. We patch the row immediately so the strike-
    through animates without waiting for a round-trip, then the form
    action persists the change. Realtime will echo it back; the merge
    in $effect harmlessly replays the same state.
  */
  function toggleLocally(id: string, checked: boolean) {
    const now = new Date().toISOString()
    localItems = localItems.map((it) =>
      it.id === id
        ? { ...it, checked_at: checked ? now : null }
        : it,
    )
  }

  /*
    HTML5 drag-and-drop reorder (desktop). We track the dragged row id
    and the drop target; on drop we splice locally then submit the new
    ordering. Up/down buttons below provide a no-pointer fallback that
    works on mobile + keyboard too.
  */
  let draggingId = $state<string | null>(null)
  let reorderForm = $state<HTMLFormElement | undefined>(undefined)

  function onDragStart(ev: DragEvent, id: string) {
    draggingId = id
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', id)
    }
  }
  function onDragOver(ev: DragEvent) {
    if (draggingId) ev.preventDefault()
  }
  function onDrop(ev: DragEvent, targetId: string) {
    ev.preventDefault()
    if (!draggingId || draggingId === targetId) return
    const ids = uncheckedItems.map((i) => i.id)
    const from = ids.indexOf(draggingId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    const next = ids.slice()
    next.splice(from, 1)
    next.splice(to, 0, draggingId)
    applyOrder(next)
    draggingId = null
  }

  function moveUp(id: string) {
    const ids = uncheckedItems.map((i) => i.id)
    const idx = ids.indexOf(id)
    if (idx <= 0) return
    const next = ids.slice()
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    applyOrder(next)
  }
  function moveDown(id: string) {
    const ids = uncheckedItems.map((i) => i.id)
    const idx = ids.indexOf(id)
    if (idx < 0 || idx === ids.length - 1) return
    const next = ids.slice()
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    applyOrder(next)
  }

  /*
    Reorder both locally (snappy) and on the server. We rebuild
    `localItems` by mapping the unchecked ids back to their rows in the
    new order, then appending the checked tail untouched.
  */
  function applyOrder(orderedIds: string[]) {
    const byId = new Map(localItems.map((i) => [i.id, i]))
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((x): x is (typeof localItems)[number] => Boolean(x))
    /*
      Re-stamp local position so the next reorder uses fresh numbers.
      Server will rewrite these on success.
    */
    reordered.forEach((row, i) => {
      row.position = i + 1
    })
    localItems = [...reordered, ...localItems.filter((i) => i.checked_at !== null)]
    queueMicrotask(() => {
      if (reorderForm) {
        const input = reorderForm.querySelector<HTMLInputElement>('input[name="ids"]')
        if (input) input.value = orderedIds.join(',')
        reorderForm.requestSubmit()
      }
    })
  }

  /*
    Realtime: live updates from other devices / household members. We
    listen on shopping_list_items (full table) and filter client-side
    by our known shelf set. Lightweight; usually <1 message/sec.
  */
  let channel: ReturnType<typeof data.supabase.channel> | undefined

  onMount(() => {
    channel = data.supabase
      .channel('shopping-list-live')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shopping_list_items',
        },
        () => {
          /*
            Cheaper to invalidate than to reconcile every payload shape
            (insert / update / delete) by hand. We already have local
            optimistic patches keeping the UI snappy; this just keeps
            the canonical state honest.
          */
          invalidate('app:shopping')
        },
      )
      .subscribe()
  })

  onDestroy(() => {
    if (channel) channel.unsubscribe()
  })

  function reasonLabel(reason: string): string {
    switch (reason) {
      case 'expired':
        return 'expired'
      case 'expiring':
        return 'expiring soon'
      case 'low_stock':
        return 'running low'
      default:
        return reason
    }
  }
</script>

<svelte:head>
  <title>shopping list · shelfAware</title>
</svelte:head>

<main class="shopping">
  <header class="shopping__header">
    <h1 class="shopping__title">
      <IconShoppingCart size={26} stroke={1.75} />
      <span>Shopping list</span>
    </h1>
    <p class="shopping__subtitle">
      Suggestions come from your shelves. Add anything else you need.
    </p>
  </header>

  {#if !data.hasShelves}
    <div class="empty">
      <p class="empty__title">Pair a shelf to start</p>
      <p class="empty__body">
        The shopping list is generated from your shelves. Pair a shelf first
        and your low-stock and expiring items will appear here as suggestions.
      </p>
      <a class="empty__cta" href="/setup">Pair a shelf</a>
    </div>
  {:else}
    <!-- Add new item -->
    <form
      class="add-form"
      method="POST"
      action="?/addItem"
      use:enhance={() => {
        addError = null
        return async ({ result, update }) => {
          await update({ reset: false })
          if (
            result.type === 'failure' &&
            result.data &&
            typeof result.data === 'object' &&
            'addItem' in result.data
          ) {
            const r = (result.data as { addItem?: { error?: string } }).addItem
            addError = r?.error ?? 'Could not add item.'
          } else if (result.type === 'success') {
            newName = ''
            newQuantity = ''
            newUnit = ''
          }
        }
      }}
    >
      <input type="hidden" name="shelf_id" value={data.primaryShelfId ?? ''} />
      <input
        type="text"
        name="name"
        bind:value={newName}
        placeholder="Add something to the list…"
        class="add-form__name"
        required
        aria-label="Item name"
        maxlength={120}
      />
      <input
        type="text"
        name="quantity"
        bind:value={newQuantity}
        placeholder="qty"
        class="add-form__qty"
        aria-label="Quantity"
        inputmode="decimal"
      />
      <input
        type="text"
        name="unit"
        bind:value={newUnit}
        placeholder="unit"
        class="add-form__unit"
        aria-label="Unit"
        maxlength={16}
      />
      <button type="submit" class="add-form__btn" aria-label="Add item">
        <IconPlus size={18} stroke={2} />
      </button>
    </form>
    {#if addError}
      <p class="form-error" role="alert">{addError}</p>
    {/if}

    <!-- Your list -->
    <section class="list" aria-labelledby="list-heading">
      <header class="section-head">
        <h2 id="list-heading" class="section-title">Your list</h2>
        <span class="section-meta">{uncheckedItems.length}</span>
      </header>

      {#if uncheckedItems.length === 0}
        <p class="empty-line">Nothing here yet. Add items above or tap a suggestion below.</p>
      {:else}
        <ul class="list__items">
          {#each uncheckedItems as item, i (item.id)}
            <li
              class="row"
              class:row--dragging={draggingId === item.id}
              draggable="true"
              ondragstart={(e) => onDragStart(e, item.id)}
              ondragover={onDragOver}
              ondrop={(e) => onDrop(e, item.id)}
              ondragend={() => (draggingId = null)}
              animate:flip={{ duration: 180 }}
            >
              <span class="row__grip" aria-hidden="true">
                <IconGripVertical size={16} stroke={1.5} />
              </span>

              <form
                method="POST"
                action="?/toggleChecked"
                class="row__check"
                use:enhance={() => {
                  toggleLocally(item.id, true)
                  return async ({ update }) => {
                    await update({ reset: false })
                  }
                }}
              >
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="checked" value="true" />
                <button
                  type="submit"
                  class="row__checkbox"
                  aria-label="Mark {item.name} as bought"
                >
                  <span class="row__checkbox-inner" aria-hidden="true"></span>
                </button>
              </form>

              {#if editingId === item.id}
                <form
                  method="POST"
                  action="?/renameItem"
                  class="row__edit"
                  use:enhance={() => {
                    editError = null
                    return async ({ result, update }) => {
                      await update({ reset: false })
                      if (
                        result.type === 'failure' &&
                        result.data &&
                        typeof result.data === 'object' &&
                        'rename' in result.data
                      ) {
                        const r = (result.data as { rename?: { error?: string } })
                          .rename
                        editError = r?.error ?? 'Could not save.'
                      } else if (result.type === 'success') {
                        editingId = null
                      }
                    }
                  }}
                >
                  <input type="hidden" name="id" value={item.id} />
                  <input
                    type="text"
                    name="name"
                    bind:value={editName}
                    class="row__edit-name"
                    aria-label="Item name"
                    required
                  />
                  <input
                    type="text"
                    name="quantity"
                    bind:value={editQuantity}
                    class="row__edit-qty"
                    aria-label="Quantity"
                    placeholder="qty"
                    inputmode="decimal"
                  />
                  <input
                    type="text"
                    name="unit"
                    bind:value={editUnit}
                    class="row__edit-unit"
                    aria-label="Unit"
                    placeholder="unit"
                    maxlength={16}
                  />
                  <button
                    type="submit"
                    class="row__edit-btn row__edit-btn--save"
                    aria-label="Save"
                  >
                    <IconCheck size={16} stroke={2} />
                  </button>
                  <button
                    type="button"
                    class="row__edit-btn"
                    aria-label="Cancel"
                    onclick={cancelEdit}
                  >
                    <IconX size={16} stroke={2} />
                  </button>
                  {#if editError}
                    <p class="form-error row__edit-error" role="alert">{editError}</p>
                  {/if}
                </form>
              {:else}
                <button
                  type="button"
                  class="row__body"
                  onclick={() => startEdit(item)}
                  aria-label="Edit {item.name}"
                >
                  <span class="row__name">{item.name}</span>
                  {#if item.quantity !== null || item.unit}
                    <span class="row__qty">
                      {item.quantity !== null ? item.quantity : ''}
                      {item.unit ?? ''}
                    </span>
                  {/if}
                  {#if item.source_reason !== 'manual'}
                    <span
                      class="row__chip"
                      class:row__chip--alert={item.source_reason === 'expired'}
                      class:row__chip--warn={item.source_reason === 'expiring'}
                    >
                      {reasonLabel(item.source_reason)}
                    </span>
                  {/if}
                </button>
              {/if}

              <div class="row__tools">
                <button
                  type="button"
                  class="row__tool"
                  aria-label="Move up"
                  disabled={i === 0}
                  onclick={() => moveUp(item.id)}
                >
                  <IconChevronUp size={16} stroke={1.75} />
                </button>
                <button
                  type="button"
                  class="row__tool"
                  aria-label="Move down"
                  disabled={i === uncheckedItems.length - 1}
                  onclick={() => moveDown(item.id)}
                >
                  <IconChevronDown size={16} stroke={1.75} />
                </button>

                <form
                  method="POST"
                  action="?/deleteItem"
                  use:enhance={() => {
                    // Optimistic local remove; server load will reconcile.
                    localItems = localItems.filter((x) => x.id !== item.id)
                    return async ({ update }) => {
                      await update({ reset: false })
                    }
                  }}
                >
                  <input type="hidden" name="id" value={item.id} />
                  <button
                    type="submit"
                    class="row__tool row__tool--danger"
                    aria-label="Delete {item.name}"
                  >
                    <IconTrash size={16} stroke={1.75} />
                  </button>
                </form>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <!--
        Hidden reorder form: programmatically submitted after a drag /
        arrow move. Kept separate from the row markup so a stray Enter
        keypress on a row's edit form doesn't accidentally trigger a
        reorder save.
      -->
      <form
        method="POST"
        action="?/reorder"
        bind:this={reorderForm}
        use:enhance={() => async ({ update }) => {
          await update({ reset: false })
        }}
      >
        <input type="hidden" name="ids" value="" />
      </form>
    </section>

    <!-- Suggestions -->
    {#if visibleSuggestions.length > 0}
      <section class="suggestions" aria-labelledby="suggestions-heading">
        <header class="section-head">
          <h2 id="suggestions-heading" class="section-title">
            From your shelves
          </h2>
          <span class="section-meta">{visibleSuggestions.length}</span>
        </header>
        <ul class="list__items">
          {#each visibleSuggestions as s (s.sourceItemId + ':' + s.reason)}
            <li
              class="row row--suggestion"
              transition:slide={{ duration: 180 }}
              animate:flip={{ duration: 180 }}
            >
              <span
                class="row__reason-icon"
                class:row__reason-icon--alert={s.reason === 'expired'}
                class:row__reason-icon--warn={s.reason === 'expiring'}
                aria-hidden="true"
              >
                {#if s.reason === 'expired'}
                  <IconAlertTriangle size={16} stroke={1.75} />
                {:else if s.reason === 'expiring'}
                  <IconClock size={16} stroke={1.75} />
                {:else}
                  <IconPackage size={16} stroke={1.75} />
                {/if}
              </span>
              <div class="row__body row__body--suggestion">
                <span class="row__name">{s.name}</span>
                <span class="row__meta">
                  {reasonLabel(s.reason)} &middot; {s.shelfName}
                </span>
              </div>
              <div class="row__tools">
                <form
                  method="POST"
                  action="?/addFromSource"
                  use:enhance={() => {
                    const key = s.sourceItemId + ':' + s.reason
                    optimisticAddedKeys = new Set([...optimisticAddedKeys, key])
                    return async ({ update }) => {
                      await update({ reset: false })
                    }
                  }}
                >
                  <input type="hidden" name="source_item_id" value={s.sourceItemId} />
                  <input type="hidden" name="source_reason" value={s.reason} />
                  <input type="hidden" name="name" value={s.name} />
                  <input type="hidden" name="shelf_id" value={s.shelfId} />
                  <button
                    type="submit"
                    class="row__tool row__tool--primary"
                    aria-label="Add {s.name}"
                  >
                    <IconPlus size={16} stroke={2} />
                  </button>
                </form>
                <form
                  method="POST"
                  action="?/dismissSuggestion"
                  use:enhance={() => {
                    const key = s.sourceItemId + ':' + s.reason
                    optimisticDismissedKeys = new Set([
                      ...optimisticDismissedKeys,
                      key,
                    ])
                    return async ({ update }) => {
                      await update({ reset: false })
                    }
                  }}
                >
                  <input type="hidden" name="source_item_id" value={s.sourceItemId} />
                  <input type="hidden" name="source_reason" value={s.reason} />
                  <button
                    type="submit"
                    class="row__tool"
                    aria-label="Dismiss {s.name}"
                  >
                    <IconX size={16} stroke={1.75} />
                  </button>
                </form>
              </div>
            </li>
          {/each}
        </ul>
        <form
          method="POST"
          action="?/clearDismissed"
          class="clear-form"
          use:enhance={() => async ({ update }) => {
            await update({ reset: false })
          }}
        >
          <button type="submit" class="text-btn">Restore dismissed</button>
        </form>
      </section>
    {/if}

    <!-- Checked / bought -->
    {#if checkedItems.length > 0}
      <section class="checked" aria-labelledby="checked-heading">
        <header class="section-head">
          <h2 id="checked-heading" class="section-title">Got it</h2>
          <form
            method="POST"
            action="?/clearChecked"
            use:enhance={() => async ({ update }) => {
              await update({ reset: false })
            }}
          >
            <button type="submit" class="text-btn">Clear all</button>
          </form>
        </header>
        <ul class="list__items">
          {#each checkedItems as item (item.id)}
            <li class="row row--checked" transition:fade={{ duration: 120 }}>
              <form
                method="POST"
                action="?/toggleChecked"
                class="row__check"
                use:enhance={() => {
                  toggleLocally(item.id, false)
                  return async ({ update }) => {
                    await update({ reset: false })
                  }
                }}
              >
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="checked" value="false" />
                <button
                  type="submit"
                  class="row__checkbox row__checkbox--checked"
                  aria-label="Unmark {item.name}"
                >
                  <IconCheck size={14} stroke={2.5} />
                </button>
              </form>
              <span class="row__body row__body--checked">
                <span class="row__name">{item.name}</span>
                {#if item.quantity !== null || item.unit}
                  <span class="row__qty">
                    {item.quantity !== null ? item.quantity : ''}
                    {item.unit ?? ''}
                  </span>
                {/if}
              </span>
              <form
                method="POST"
                action="?/deleteItem"
                use:enhance={() => {
                  localItems = localItems.filter((x) => x.id !== item.id)
                  return async ({ update }) => {
                    await update({ reset: false })
                  }
                }}
              >
                <input type="hidden" name="id" value={item.id} />
                <button
                  type="submit"
                  class="row__tool row__tool--danger"
                  aria-label="Delete {item.name}"
                >
                  <IconTrash size={16} stroke={1.75} />
                </button>
              </form>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</main>

<style>
  .shopping {
    width: 100%;
    padding: 2rem 1rem 8rem;
    box-sizing: border-box;
    max-width: 32rem;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .shopping__header h1 {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.2;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
  }

  .shopping__title :global(svg) {
    color: var(--matcha-deep);
  }

  .shopping__subtitle {
    margin: 0.3rem 0 0;
    opacity: 0.7;
    font-size: 0.9rem;
  }

  .empty {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.5rem 1.25rem;
    text-align: center;
  }
  .empty__title {
    margin: 0 0 0.4rem;
    font-weight: 600;
  }
  .empty__body {
    margin: 0 0 0.85rem;
    opacity: 0.75;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .empty__cta {
    display: inline-block;
    padding: 0.5rem 0.95rem;
    background: var(--matcha);
    color: #fff;
    border-radius: var(--radius-pill);
    text-decoration: none;
    font-weight: 500;
  }

  /* ── Add form ───────────────────────────────────────────────────────── */

  .add-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 4rem 4rem auto;
    gap: 0.4rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.4rem;
  }

  .add-form input {
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.95rem;
    padding: 0.45rem 0.55rem;
    border-radius: var(--radius-sm);
    min-width: 0;
  }

  .add-form input:focus {
    outline: 2px solid var(--matcha);
    outline-offset: -1px;
  }

  .add-form__qty,
  .add-form__unit {
    font-size: 0.85rem;
    opacity: 0.85;
  }

  .add-form__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.4rem;
    height: 2.4rem;
    border: none;
    background: var(--matcha);
    color: #fff;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .add-form__btn:hover,
  .add-form__btn:focus-visible {
    background: var(--matcha-deep);
  }

  .form-error {
    margin: 0.25rem 0 0;
    color: var(--error, #c0392b);
    font-size: 0.85rem;
  }

  /* ── Section heads ─────────────────────────────────────────────────── */

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .section-title {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.65;
  }

  .section-meta {
    font-size: 0.78rem;
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
  }

  .empty-line {
    margin: 0;
    padding: 0.85rem 0;
    opacity: 0.65;
    font-size: 0.9rem;
  }

  /* ── Rows ──────────────────────────────────────────────────────────── */

  .list__items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    min-width: 0;
  }

  .row--suggestion {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .row--dragging {
    opacity: 0.4;
  }

  .row__grip {
    opacity: 0.35;
    cursor: grab;
    display: inline-flex;
  }
  .row--dragging .row__grip {
    cursor: grabbing;
  }

  .row__check {
    margin: 0;
    display: inline-flex;
  }

  .row__checkbox {
    width: 1.5rem;
    height: 1.5rem;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }

  .row__checkbox:hover {
    border-color: var(--matcha);
  }

  .row__checkbox--checked {
    background: var(--matcha);
    border-color: var(--matcha);
  }

  .row__checkbox-inner {
    width: 0;
    height: 0;
  }

  .row__body {
    appearance: none;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .row__body--suggestion,
  .row__body--checked {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    cursor: default;
  }

  .row__name {
    font-size: 0.95rem;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .row--checked .row__name {
    text-decoration: line-through;
    opacity: 0.55;
  }

  .row__qty {
    font-size: 0.78rem;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }

  .row__meta {
    font-size: 0.75rem;
    opacity: 0.65;
  }

  .row__chip {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--background);
    color: var(--text);
    opacity: 0.7;
  }
  .row__chip--warn {
    background: var(--warn-soft);
    color: var(--warn);
    opacity: 1;
  }
  .row__chip--alert {
    background: rgba(192, 57, 43, 0.1);
    color: var(--error, #c0392b);
    opacity: 1;
  }

  .row__reason-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.8rem;
    height: 1.8rem;
    border-radius: var(--radius-sm);
    background: var(--background);
    color: var(--text);
    opacity: 0.75;
  }
  .row__reason-icon--warn {
    background: var(--warn-soft);
    color: var(--warn);
    opacity: 1;
  }
  .row__reason-icon--alert {
    background: rgba(192, 57, 43, 0.1);
    color: var(--error, #c0392b);
    opacity: 1;
  }

  .row__tools {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .row__tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border: none;
    background: transparent;
    color: inherit;
    border-radius: var(--radius-sm);
    cursor: pointer;
    opacity: 0.65;
    transition: background-color 0.15s ease, opacity 0.15s ease, color 0.15s ease;
  }
  .row__tool:hover:not(:disabled),
  .row__tool:focus-visible:not(:disabled) {
    background: var(--background);
    opacity: 1;
  }
  .row__tool:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }
  .row__tool--danger:hover,
  .row__tool--danger:focus-visible {
    color: var(--error, #c0392b);
    background: rgba(192, 57, 43, 0.08);
  }
  .row__tool--primary {
    background: var(--matcha);
    color: #fff;
    opacity: 1;
  }
  .row__tool--primary:hover,
  .row__tool--primary:focus-visible {
    background: var(--matcha-deep);
    color: #fff;
    opacity: 1;
  }

  /* ── Inline edit ───────────────────────────────────────────────────── */

  /*
    The edit form replaces the row body in the grid. On desktop we can
    fit name + qty + unit + save + cancel on one line; on mobile that
    pinches everything down to nothing, so we wrap onto two rows with
    the name field spanning the full width.
  */
  .row__edit {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 3.5rem 3.5rem auto auto;
    gap: 0.3rem;
    align-items: center;
    grid-column: 3 / span 1;
  }

  .row__edit-name {
    /* Name takes the first column on desktop, full row on mobile. */
    grid-column: 1 / 2;
  }

  .row__edit input {
    border: 1px solid var(--border);
    background: var(--background);
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
    padding: 0.3rem 0.45rem;
    border-radius: var(--radius-sm);
    min-width: 0;
  }
  .row__edit-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    border-radius: var(--radius-sm);
    cursor: pointer;
    flex-shrink: 0;
  }
  .row__edit-btn--save {
    background: var(--matcha);
    color: #fff;
    border-color: var(--matcha-deep);
  }

  .row__edit-error {
    grid-column: 1 / -1;
  }

  /*
    Editing a row already has save / cancel buttons; the row-level
    up/down/trash tools next to them are redundant and the trash is
    one accidental click from being destructive. Hide them while the
    inline editor is mounted.
  */
  .row:has(.row__edit) .row__tools {
    display: none;
  }

  /* ── Suggestions / Checked tweaks ──────────────────────────────────── */

  .suggestions .row__name {
    white-space: normal;
  }

  .clear-form,
  .checked .section-head form {
    margin: 0.5rem 0 0;
  }

  .text-btn {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    opacity: 0.65;
    cursor: pointer;
    padding: 0.25rem 0;
  }
  .text-btn:hover,
  .text-btn:focus-visible {
    opacity: 1;
    color: var(--matcha-deep);
  }

  /* Tighten on narrow screens. */
  @media (max-width: 420px) {
    .add-form {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .add-form__qty,
    .add-form__unit {
      display: none;
    }
    .row__grip {
      display: none;
    }
    .row {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    /*
      Edit form was a single-row 5-column grid; on phones that squashes
      everything. Reflow to two rows: the name spans the full width on
      top, then qty / unit / save / cancel share row 2.
    */
    .row__edit {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto;
      /* Edit form now owns the full row width (cols 2 and 3 of the
         outer grid: checkbox | body | tools). The checkbox slot stays
         to the left; we let the edit form steal everything else. */
      grid-column: 2 / -1;
    }
    .row__edit-name {
      grid-column: 1 / -1;
    }
  }
</style>
