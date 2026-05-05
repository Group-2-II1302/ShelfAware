<script lang="ts">
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()
</script>

<h1>welcome to shelfAware</h1>
<p>your shelves</p>

<ul class="shelf-list">
  {#each data.shelves as shelf (shelf.id)}
    <li class="shelf-list__item">
      <a
        href="/shelves/{shelf.id}"
        class="shelf-list__link"
      >
        {shelf.name}
      </a>
    </li>
  {/each}
</ul>