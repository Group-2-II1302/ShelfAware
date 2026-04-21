<script lang="ts">
  import {
    IconHome2Filled,
    IconCameraFilled,
    IconBellFilled,
    IconDots,
    IconPlus,
  } from '@tabler/icons-svelte'

  let { onAddShelf = () => {} } = $props<{
    onAddShelf?: () => void
  }>()
</script>

<nav id="menu" aria-label="Primary menu">
  <div class="menu-row">
    <a href="/" class="menu-row__item" aria-label="Home">
      <IconHome2Filled />
    </a>

    <a href="/scan-item" class="menu-row__item" aria-label="Scan item">
      <IconCameraFilled />
    </a>

    <a href="/inbox" class="menu-row__item" aria-label="Inbox">
      <IconBellFilled />
    </a>

    <button
      type="button"
      class="menu-row__item menu-row__item--action"
      aria-label="Create new shelf"
      onclick={onAddShelf}
    >
      <IconPlus />
    </button>

    <span class="menu-row__item menu-row__item--static" aria-hidden="true">
      <IconDots />
    </span>
  </div>
</nav>