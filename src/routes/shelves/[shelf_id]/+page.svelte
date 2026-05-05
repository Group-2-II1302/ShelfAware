<script lang="ts">
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const dateFormatter = new Intl.DateTimeFormat('en-GB')

  function getProductName(item: PageData['items'][number]) {
    return item.product_catalog?.[0]?.product_name ?? item.barcode
  }

  function formatExpiryDate(expiryDate: string | null) {
    if (!expiryDate) {
      return 'No expiry date'
    }

    return dateFormatter.format(new Date(expiryDate))
  }
</script>

<svelte:head>
  <title>{data.shelf.name} · shelfAware</title>
</svelte:head>

<main class="shelf-page">
  <header class="shelf-header">
    <h1 class="shelf-title">
      {data.shelf.name}
    </h1>
  </header>

  {#if data.items.length === 0}
    <section class="empty-shelf">
      <p>
        This shelf is empty.
      </p>
    </section>
  {:else}
    <ul class="item-list">
      {#each data.items as item (item.id)}
        <li class="item-card">
          <div class="item-card__content">
            <h2 class="item-card__title">
              {getProductName(item)}
            </h2>

            <p class="item-card__expiry">
              expires:
              {formatExpiryDate(item.expiry_date)}
            </p>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .shelf-page {
    width: 100%;
    padding: 1rem;
    box-sizing: border-box;
  }

  .shelf-header {
    margin-bottom: 1rem;
  }

  .shelf-title {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.2;
  }

  .item-list {
    list-style: none;
    margin: 0;
    padding: 0;

    display: grid;
    gap: 1rem;
  }

  .item-card {
    background: var(--surface);
    border-radius: 1rem;

    padding: 1.25rem;

    min-height: 6rem;

    display: flex;
    align-items: center;

    box-sizing: border-box;
  }

  .item-card__content {
    width: 100%;
  }

  .item-card__title {
    margin: 0;

    font-size: 1rem;
    line-height: 1.3;

    overflow-wrap: anywhere;
  }

  .item-card__expiry {
    margin: 0.5rem 0 0 0;

    font-size: 0.875rem;
    line-height: 1.3;

    overflow-wrap: anywhere;
  }

  .empty-shelf {
    background: var(--surface);

    border-radius: 1rem;

    padding: 1.25rem;

    box-sizing: border-box;
  }

  .empty-shelf p {
    margin: 0;
  }

  @media (min-width: 768px) {
    .shelf-page {
      max-width: 32rem;
      margin: 0 auto;
    }
  }
</style>