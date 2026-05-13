<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import { goto } from '$app/navigation'
  import {
    IconHome2Filled,
    IconCameraFilled,
    IconBellFilled,
    IconUserFilled,
    IconShoppingCartFilled,
    IconLogout,
    IconSettings,
  } from '@tabler/icons-svelte'
  import { unreadAlerts } from '$lib/stores/alerts.svelte'
  import { supabase } from '$lib/supabaseClient'

  let profileOpen = $state(false)
  let profileWrapper = $state<HTMLLIElement | null>(null)
  let loggingOut = $state(false)

  function toggleProfile() {
    profileOpen = !profileOpen
  }

  function closeProfile() {
    profileOpen = false
  }

  /*
    Close on outside click + Escape. Listeners are attached only
    while the popover is open so we don't pay the cost the rest of
    the time. SSR-guarded for safety.
  */
  function handleDocClick(e: MouseEvent) {
    if (!profileWrapper) return
    if (!profileWrapper.contains(e.target as Node)) closeProfile()
  }

  function handleDocKey(e: KeyboardEvent) {
    if (e.key === 'Escape') closeProfile()
  }

  $effect(() => {
    if (typeof document === 'undefined') return
    if (profileOpen) {
      document.addEventListener('click', handleDocClick)
      document.addEventListener('keydown', handleDocKey)
      return () => {
        document.removeEventListener('click', handleDocClick)
        document.removeEventListener('keydown', handleDocKey)
      }
    }
  })

  async function logout() {
    if (loggingOut) return
    loggingOut = true
    try {
      await supabase.auth.signOut()
      closeProfile()
      await goto('/login')
    } finally {
      loggingOut = false
    }
  }

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', handleDocClick)
      document.removeEventListener('keydown', handleDocKey)
    }
  })
</script>

<div id="menu">
  <ul>
    <li>
      <a href="/" aria-label="Home"><IconHome2Filled size={32} /></a>
    </li>
    <li>
      <a href="/shopping" aria-label="Shopping list">
        <IconShoppingCartFilled size={32} />
      </a>
    </li>
    <li class="menu__camera">
      <a
        href="/scan-item"
        aria-label="Scan item"
        data-sveltekit-preload-data="off"
      >
        <IconCameraFilled size={32} />
      </a>
    </li>
    <li class="menu__bell">
      <a
        href="/inbox"
        aria-label="Inbox{unreadAlerts.count > 0
          ? ', ' + unreadAlerts.count + ' unread'
          : ''}"
      >
        <IconBellFilled size={32} />
        {#if unreadAlerts.count > 0}
          <span class="menu__badge" aria-hidden="true">
            {unreadAlerts.count > 99 ? '99+' : unreadAlerts.count}
          </span>
        {/if}
      </a>
    </li>
    <li class="menu__profile" bind:this={profileWrapper}>
      <button
        type="button"
        class="menu__profile-trigger"
        aria-haspopup="menu"
        aria-expanded={profileOpen}
        aria-label="Account menu"
        onclick={toggleProfile}
      >
        <IconUserFilled size={32} />
      </button>

      {#if profileOpen}
        <div
          class="profile-popover"
          role="menu"
          transition:fly={{ y: 8, duration: 160, easing: quintOut }}
        >
          <a
            href="/profile"
            role="menuitem"
            class="profile-popover__item"
            onclick={closeProfile}
          >
            <IconSettings size={18} stroke={1.75} />
            <span>Profile</span>
          </a>
          <button
            type="button"
            role="menuitem"
            class="profile-popover__item profile-popover__item--danger"
            disabled={loggingOut}
            onclick={logout}
          >
            <IconLogout size={18} stroke={1.75} />
            <span>{loggingOut ? 'Logging out…' : 'Log out'}</span>
          </button>
        </div>
      {/if}
    </li>
  </ul>
</div>

<style>
  /* Existing bell badge */
  .menu__bell a {
    position: relative;
    display: inline-flex;
  }

  .menu__badge {
    position: absolute;
    top: -4px;
    right: -8px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--error);
    color: var(--accent-contrast);
    font-family: 'Cascadia Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    line-height: 18px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--background);
    pointer-events: none;
  }

  /*
    Profile trigger renders as a transparent button so it lines up
    with the existing <a> tap targets. We anchor the popover off
    its parent <li> via position:relative.
  */
  .menu__profile {
    position: relative;
  }

  .menu__profile-trigger,
  .menu__profile-trigger:hover,
  .menu__profile-trigger:focus,
  .menu__profile-trigger:focus-visible,
  .menu__profile-trigger:active {
    background: transparent;
    border: none;
    outline: none;
    box-shadow: none;
    padding: 0;
    margin: 0;
    color: var(--text);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }

  .menu__profile-trigger :global(svg) {
    color: var(--text);
  }

  /*
    Pop above the bar (bar sits at bottom: 30px). We anchor right so
    the popover stays inside the viewport on narrow screens; the
    `right: 0` plus translate keeps it tucked over the user icon.
  */
  .profile-popover {
    position: absolute;
    bottom: calc(100% + 0.85rem);
    right: -0.25rem;
    min-width: 12rem;
    background: var(--surface);
    border-radius: var(--radius-md);
    padding: 0.5rem;
    box-shadow:
      0 14px 30px rgba(51, 42, 38, 0.15),
      0 2px 6px rgba(51, 42, 38, 0.08);
    border: 1px solid rgba(51, 42, 38, 0.06);
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  /* Little tail pointing at the trigger for affordance. */
  .profile-popover::after {
    content: '';
    position: absolute;
    top: 100%;
    right: 1rem;
    width: 12px;
    height: 12px;
    background: var(--surface);
    border-right: 1px solid rgba(51, 42, 38, 0.06);
    border-bottom: 1px solid rgba(51, 42, 38, 0.06);
    transform: translateY(-50%) rotate(45deg);
  }

  .profile-popover__item {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    color: var(--text);
    font: inherit;
    font-size: 0.92rem;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    box-sizing: border-box;
    width: 100%;
    transition: background-color 0.12s ease;
  }

  .profile-popover__item:hover,
  .profile-popover__item:focus-visible {
    background: var(--background);
    outline: none;
  }

  .profile-popover__item :global(svg) {
    color: var(--text);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .profile-popover__item--danger {
    color: var(--error);
  }

  .profile-popover__item--danger :global(svg) {
    color: var(--error);
    opacity: 1;
  }

  .profile-popover__item--danger:hover,
  .profile-popover__item--danger:focus-visible {
    background: #fbecec;
  }

  .profile-popover__item:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
