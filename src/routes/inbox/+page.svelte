<script lang="ts">
  let { data } = $props();
</script>

<h1>Inbox</h1>
<button
  onclick={function () {
    history.back();
  }}>Back to home</button
>

<ul>
  {#each data.notifications as n}
    <li>
      <strong>{n.message}</strong>
      <p>{n.timestamp}</p>
    </li>
  {:else}
    <p>No notifications found.</p>
  {/each}
</ul>
