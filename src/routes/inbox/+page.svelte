<script lang="ts">
  let { data } = $props();

  const getDays = (date: string | null) => {
    if (!date) return null;
    return Math.floor(
      (new Date(date).getTime() - new Date().getTime()) / 86400000,
    );
  };

  const formatDate = (dateStr: string | null) => {
    return dateStr ? new Date(dateStr).toLocaleDateString() : "Unknown date";
  };
</script>

<h1>Inbox</h1>
<button onclick={() => history.back()}>Go back</button>

{#each data.notifications as n}
  {@const days = n.shelf_items ? getDays(n.shelf_items.expiry_date) : null}
  <li>
    <strong>
      {#if n.shelf_items}
        {n.shelf_items.barcode}
        {#if days !== null}
          {days < 0
            ? "expired"
            : days === 0
              ? "expires today"
              : `expires in ${days} days`}
        {:else}
          (No expiry date set)
        {/if}
      {:else}
        {n.alert_type}
      {/if}
    </strong>
    <p>{formatDate(n.last_triggered_at)}</p>
  </li>
{:else}
  <p>No notifications found.</p>
{/each}
