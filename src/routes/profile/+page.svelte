<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { enhance } from '$app/forms'
  import { page } from '$app/state'
  import type { ActionData, PageData } from './$types'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let loading = $state(false)
  let error = $state<string | null>(null)

  let notifyEmail = $state(true)
  let notifyPush = $state(false)
  let notifyLowStock = $state(true)
  let notifyExpiry = $state(true)

  let editingShelfId = $state<string | null>(null)
  let editDraft = $state('')

  function startEditingShelf(shelf: { id: string; name: string }) {
    editingShelfId = shelf.id
    editDraft = shelf.name
  }

  function formatSyncedAt(iso: string | null) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }

  function display(value: string | null | undefined) {
    const v = value?.trim()
    return v ? v : '—'
  }

  async function logout() {
    loading = true
    error = null
    const { error: err } = await page.data.supabase.auth.signOut()
    loading = false
    if (err) {
      error = err.message
      return
    }
    await invalidateAll()
    await goto('/login')
  }
</script>

<main class="settings">
  <div class="profile-actions settings__actions--top">
    <button type="button" onclick={() => history.back()}>go back</button>
    <button type="button" disabled={loading} onclick={logout}>
      {loading ? 'signing out…' : 'log out'}
    </button>
  </div>

  {#if error}
    <p role="alert" class="alert alert--error settings__top-error">{error}</p>
  {/if}

  <section class="settings__section">
    <h2 class="settings__heading">profile</h2>
    <div class="settings__card settings__card--fields">
      <div class="settings__field">
        <span class="settings__label">first_name</span>
        <span class="settings__value">{display(data.profile?.first_name)}</span>
      </div>
      <div class="settings__field">
        <span class="settings__label">last_name</span>
        <span class="settings__value">{display(data.profile?.last_name)}</span>
      </div>
      <div class="settings__field">
        <span class="settings__label">email</span>
        <span class="settings__value">{display(data.profile?.email)}</span>
      </div>
      <div class="settings__field">
        <span class="settings__label">phone_number</span>
        <span class="settings__value">{display(data.profile?.phone_number)}</span>
      </div>
    </div>
  </section>

  <hr class="settings__rule" />

  <section class="settings__section">
    <h2 class="settings__heading">notifications</h2>
    <div class="settings__card">
      <div class="settings__toggle-row">
        <span class="settings__toggle-label" id="settings-notify-email">email notifications</span>
        <button
          type="button"
          class="settings__switch"
          role="switch"
          aria-labelledby="settings-notify-email"
          aria-checked={notifyEmail}
          onclick={() => (notifyEmail = !notifyEmail)}
        >
          <span class="settings__switch-thumb" data-on={notifyEmail}></span>
        </button>
      </div>
      <div class="settings__toggle-row">
        <span class="settings__toggle-label" id="settings-notify-push">push notifications</span>
        <button
          type="button"
          class="settings__switch"
          role="switch"
          aria-labelledby="settings-notify-push"
          aria-checked={notifyPush}
          onclick={() => (notifyPush = !notifyPush)}
        >
          <span class="settings__switch-thumb" data-on={notifyPush}></span>
        </button>
      </div>
      <div class="settings__toggle-row">
        <span class="settings__toggle-label" id="settings-notify-low">low stock alerts</span>
        <button
          type="button"
          class="settings__switch"
          role="switch"
          aria-labelledby="settings-notify-low"
          aria-checked={notifyLowStock}
          onclick={() => (notifyLowStock = !notifyLowStock)}
        >
          <span class="settings__switch-thumb" data-on={notifyLowStock}></span>
        </button>
      </div>
      <div class="settings__toggle-row">
        <span class="settings__toggle-label" id="settings-notify-expiry">expiry alerts</span>
        <button
          type="button"
          class="settings__switch"
          role="switch"
          aria-labelledby="settings-notify-expiry"
          aria-checked={notifyExpiry}
          onclick={() => (notifyExpiry = !notifyExpiry)}
        >
          <span class="settings__switch-thumb" data-on={notifyExpiry}></span>
        </button>
      </div>
    </div>
  </section>

  <hr class="settings__rule" />

  <section class="settings__section">
    <h2 class="settings__heading">manage devices</h2>
    {#if data.shelves.length === 0}
      <p class="settings__empty">no shelves linked to your account</p>
    {:else}
      <ul class="settings__device-list">
        {#each data.shelves as shelf (shelf.id)}
          <li class="settings__device-card">
            <div class="settings__device-inner">
              {#if editingShelfId === shelf.id}
                <form
                  method="POST"
                  action="?/renameShelf"
                  class="settings__device-rename"
                  use:enhance={() => {
                    return async ({ result, update }) => {
                      await update()
                      if (result.type === 'success') {
                        const d = result.data as { renameSuccess?: boolean } | undefined
                        if (d?.renameSuccess) editingShelfId = null
                      }
                    }
                  }}
                >
                  <input type="hidden" name="shelf_id" value={shelf.id} />
                  <label class="settings__device-name-label" for="shelf-name-{shelf.id}"
                    >name</label
                  >
                  <div class="settings__device-name-row">
                    <input
                      id="shelf-name-{shelf.id}"
                      class="settings__device-name-input"
                      type="text"
                      name="name"
                      bind:value={editDraft}
                      maxlength="200"
                      autocomplete="off"
                      required
                    />
                    <button type="submit" class="settings__device-save">save</button>
                  </div>
                </form>
              {:else}
                <div class="settings__device-name-field">
                  <span class="settings__device-name-label">name</span>
                  <div class="settings__device-name-row">
                    <span class="settings__device-name-display">{shelf.name}</span>
                    <button
                      type="button"
                      class="settings__device-edit"
                      onclick={() => startEditingShelf(shelf)}
                    >
                      edit
                    </button>
                  </div>
                </div>
              {/if}
              {#if form && 'renameError' in form && form.renameShelfId === shelf.id && form.renameError}
                <p class="settings__inline-error" role="alert">{form.renameError}</p>
              {/if}
              {#if form && 'renameSuccess' in form && form.renameSuccess && form.renameShelfId === shelf.id}
                <p class="settings__inline-success" role="status">name saved</p>
              {/if}
              <div class="settings__device-meta-stack">
                <div class="settings__device-meta-block">
                  <span class="settings__device-meta-key">id</span>
                  <span class="settings__device-meta-value">{shelf.id}</span>
                </div>
                <div class="settings__device-meta-block">
                  <span class="settings__device-meta-key">last synced</span>
                  <span class="settings__device-meta-value">{formatSyncedAt(shelf.last_synced_at)}</span>
                </div>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>
