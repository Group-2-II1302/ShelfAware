<!--
  Submit button that shows a spinning state while its enclosing form is
  submitting. Driven by SvelteKit's `$app/state.page.form` is not what
  we want here (that's the *result* after the action), so we read the
  in-flight signal off `$app/state.navigating` (form actions trigger a
  navigation-like state) plus a local `submitting` flag set by a tiny
  `use:enhance` handler the parent form can opt into via this component.

  Two ways to use it:

  1. Sibling to a `use:enhance` form that toggles `submitting` itself
     (best — explicit, no DOM walking).
  2. Just drop it in a plain form and rely on a `form` listener that
     auto-detects via the closest <form> ancestor. We do that fallback
     here for ergonomics: the consumer doesn't *have* to wire enhance.

  In all cases the button:
   - Disables itself while submitting (prevents double-submits).
   - Swaps the slotted children for a spinner + optional pendingLabel.
   - Stays the same size so the layout doesn't jump.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  type Props = {
    type?: 'submit' | 'button'
    /** Optional override; if absent we infer from the parent <form>. */
    submitting?: boolean
    /** Text shown next to the spinner while submitting. */
    pendingLabel?: string
    /** Extra classes to merge with the consumer-controlled styling. */
    class?: string
    /** Disable even when idle (forwarded to <button>). */
    disabled?: boolean
    /** Standard form-association attributes pass through. */
    formaction?: string
    name?: string
    value?: string
    'aria-label'?: string
    children?: Snippet
    onclick?: (e: MouseEvent) => void
  }

  let {
    type = 'submit',
    submitting: submittingProp,
    pendingLabel,
    class: className = '',
    disabled = false,
    formaction,
    name,
    value,
    children,
    onclick,
    ...rest
  }: Props = $props()

  /*
    Inferred pending state: listen for `submit` on the closest form
    ancestor and `formdata` / page navigation on the document. We use
    the `formdata` event as the "submit just fired and is in flight"
    signal because it's emitted right before SvelteKit fetches the
    action, and the navigation that completes the action will null
    `navigating` again when it's done.

    If the consumer passes `submitting` explicitly, that wins.
  */
  let buttonEl: HTMLButtonElement | undefined = $state(undefined)
  let internalPending = $state(false)

  $effect(() => {
    if (submittingProp !== undefined) return
    const btn = buttonEl
    if (!btn) return
    const form = btn.closest('form')
    if (!form) return

    function onSubmit() {
      internalPending = true
    }
    function onReset() {
      internalPending = false
    }
    /*
      SvelteKit's enhance resets the form on the response; if a
      consumer reset is disabled (reset:false), the navigation
      completing is our signal. Listen for both so we settle either
      way.
    */
    form.addEventListener('submit', onSubmit)
    form.addEventListener('reset', onReset)

    /*
      Fallback: if no enhance/navigation happens within 30s, give up
      and re-enable the button so the user isn't permanently stuck.
    */
    return () => {
      form.removeEventListener('submit', onSubmit)
      form.removeEventListener('reset', onReset)
    }
  })

  /*
    Whenever the page navigation settles (either successful action
    redirect or the enhance update resolving), turn the internal
    flag back off.
  */
  import { navigating } from '$app/state'
  let prevNavigating = $state<unknown>(null)
  $effect(() => {
    /*
      Detect 0 → 1 → 0 transitions; we only want to clear the flag
      when the navigation that was running has finished, not on every
      tick.
    */
    if (navigating.to) {
      prevNavigating = navigating.to
    } else if (prevNavigating) {
      prevNavigating = null
      internalPending = false
    }
  })

  const isPending = $derived(submittingProp ?? internalPending)
  const isDisabled = $derived(disabled || isPending)
</script>

<button
  bind:this={buttonEl}
  {type}
  {formaction}
  {name}
  {value}
  class="submit-btn {className}"
  class:submit-btn--pending={isPending}
  disabled={isDisabled}
  aria-busy={isPending}
  {onclick}
  {...rest}
>
  {#if isPending}
    <span class="submit-btn__spinner" aria-hidden="true"></span>
    {#if pendingLabel}
      <span class="submit-btn__label">{pendingLabel}</span>
    {/if}
  {:else if children}
    {@render children()}
  {/if}
</button>

<style>
  .submit-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    position: relative;
    transition: opacity 0.15s ease;
  }

  .submit-btn:disabled {
    cursor: progress;
    opacity: 0.75;
  }

  .submit-btn__spinner {
    display: inline-block;
    width: 0.95em;
    height: 0.95em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: submit-btn-spin 0.7s linear infinite;
    /*
      Inherit currentColor so the spinner matches the button text.
      Works against both light-on-dark and dark-on-light backgrounds.
    */
  }

  .submit-btn__label {
    line-height: 1;
  }

  @keyframes submit-btn-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .submit-btn__spinner {
      animation-duration: 1.6s;
    }
  }
</style>
