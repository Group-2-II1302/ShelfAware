<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { page } from '$app/state'

  let firstName = $state('')
  let lastName = $state('')
  let email = $state('')
  let phone = $state('')
  let password = $state('')
  let passwordConfirm = $state('')

  let error = $state<string | null>(null)
  let signupMessage = $state<string | null>(null)
  let loading = $state(false)
  let mode = $state<'signin' | 'signup'>('signin')

  function resetMessages() {
    error = null
    signupMessage = null
  }

  function switchMode(next: 'signin' | 'signup') {
    mode = next
    resetMessages()
    if (next === 'signin') {
      passwordConfirm = ''
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    resetMessages()
    loading = true

    const supabase = page.data.supabase

    if (mode === 'signin') {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      loading = false
      if (err) {
        error = err.message
        return
      }
      await invalidateAll()
      await goto('/')
      return
    }

    const fn = firstName.trim()
    const ln = lastName.trim()
    if (!fn || !ln) {
      loading = false
      error = 'Please enter your first and last name.'
      return
    }

    if (password !== passwordConfirm) {
      loading = false
      error = 'Passwords do not match.'
      return
    }

    const meta: Record<string, string> = {
      first_name: fn,
      last_name: ln,
    }
    const phoneTrimmed = phone.trim()
    if (phoneTrimmed) {
      meta.phone = phoneTrimmed
    }

    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: meta,
      },
    })

    loading = false

    if (err) {
      error = err.message
      return
    }

    if (data.session) {
      await invalidateAll()
      await goto('/')
      return
    }

    signupMessage =
      'Account created. Check your email for a confirmation link, then sign in below with your email and password.'

    password = ''
    passwordConfirm = ''
  }
</script>

<main class="auth-main">
  <div class="auth-card">
    <h1 class="auth-card__title">shelfAware</h1>
    <p class="auth-card__intro">
      {mode === 'signin' ? 'Sign in to continue' : 'Create an account'}
    </p>

    {#if signupMessage}
      <p role="status" class="auth-notice">
        {signupMessage}
      </p>
    {/if}

    <form class="stack-form" onsubmit={submit}>
      {#if mode === 'signup'}
        <label class="field">
          First name
          <input
            type="text"
            name="firstName"
            autocomplete="given-name"
            bind:value={firstName}
            required
            class="input"
          />
        </label>
        <label class="field">
          Last name
          <input
            type="text"
            name="lastName"
            autocomplete="family-name"
            bind:value={lastName}
            required
            class="input"
          />
        </label>
      {/if}

      <label class="field">
        Email
        <input
          type="email"
          name="email"
          autocomplete="email"
          bind:value={email}
          required
          class="input"
        />
      </label>

      {#if mode === 'signup'}
        <label class="field">
          Phone number <span class="field-hint">(optional)</span>
          <input
            type="tel"
            name="phone"
            autocomplete="tel"
            bind:value={phone}
            class="input"
          />
        </label>
      {/if}

      <label class="field">
        Password
        <input
          type="password"
          name="password"
          autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
          bind:value={password}
          required
          minlength="6"
          class="input"
        />
      </label>

      {#if mode === 'signup'}
        <label class="field">
          Confirm password
          <input
            type="password"
            name="passwordConfirm"
            autocomplete="new-password"
            bind:value={passwordConfirm}
            required
            minlength="6"
            class="input"
          />
        </label>
      {/if}

      {#if error}
        <p role="alert" class="alert alert--error">{error}</p>
      {/if}

      <button type="submit" class="btn-primary" disabled={loading}>
        {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
      </button>
    </form>

    <p class="auth-switch">
      {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}
      <button
        type="button"
        class="link-button"
        onclick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
      >
        {mode === 'signin' ? 'Sign up' : 'Sign in'}
      </button>
    </p>
  </div>
</main>
