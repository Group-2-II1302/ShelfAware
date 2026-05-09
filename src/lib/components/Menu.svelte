<script lang="ts">
  import {
    IconHome2Filled,
    IconCameraFilled,
    IconBellFilled,
    IconDots,
  } from '@tabler/icons-svelte'
  import { unreadAlerts } from '$lib/stores/alerts.svelte'
</script>

<div id="menu">
  <ul>
    <li><a href="/"><IconHome2Filled size={32} /></a></li>
    <li>
      <a href="/scan-item" data-sveltekit-preload-data="off">
        <IconCameraFilled size={32} />
      </a>
    </li>
    <li class="menu__bell">
      <a href="/inbox" aria-label="Inbox{unreadAlerts.count > 0 ? ', ' + unreadAlerts.count + ' unread' : ''}">
        <IconBellFilled size={32} />
        {#if unreadAlerts.count > 0}
          <span class="menu__badge" aria-hidden="true">
            {unreadAlerts.count > 99 ? '99+' : unreadAlerts.count}
          </span>
        {/if}
      </a>
    </li>
    <li><IconDots size={32} /></li>
  </ul>
</div>

<style>
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
</style>
