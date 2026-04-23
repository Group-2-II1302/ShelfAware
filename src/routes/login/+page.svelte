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

  async function signInWithGoogle() {
    resetMessages()
    loading = true

    const supabase = page.data.supabase

    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (err) {
      loading = false
      error = err.message
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

    <button
      type="button"
      class="btn-google"
      onclick={signInWithGoogle}
      disabled={loading}
    >
      <svg
        class="btn-google__icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 48 48"
        aria-hidden="true"
      >
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
        <path fill="none" d="M0 0h48v48H0z" />
      </svg>
      Continue with Google
    </button>

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
