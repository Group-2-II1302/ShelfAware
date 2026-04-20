<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { page } from '$app/state'

  let loading = $state(false)
  let error = $state<string | null>(null)

  const email = $derived(
    (page.data.claims as { email?: string } | null)?.email ?? null,
  )

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

<h1>Profile</h1>

{#if email}
  <p>email: {email}</p>
{:else}
  <p>email: —</p>
{/if}

{#if error}
  <p role="alert" class="alert alert--error">{error}</p>
{/if}

<div class="profile-actions">
  <button type="button" onclick={() => history.back()}>Go back</button>
  <button type="button" disabled={loading} onclick={logout}>
    {loading ? 'Signing out…' : 'Log out'}
  </button>
</div>
