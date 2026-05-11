<script lang="ts">
  import favicon from '$lib/assets/favicon.svg'
  import '$lib/styles/stylesheet.css'
  import { invalidate } from '$app/navigation'
  import { onMount } from 'svelte'

  import Menu from '$lib/components/Menu.svelte'
  import AlertsListener from '$lib/components/AlertsListener.svelte'
  import NavigationProgress from '$lib/components/NavigationProgress.svelte'

  let { data, children } = $props()
  let { supabase, claims, unreadAlertCount } = $derived(data)

  onMount(() => {
    const { data } = supabase.auth.onAuthStateChange((event, _session) => {
      if (_session?.expires_at !== claims?.exp) {
        invalidate('supabase:auth')
      }
    })
    return () => data.subscription.unsubscribe()
  })
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<NavigationProgress />

{@render children()}

<Menu />

{#if claims}
  <AlertsListener {supabase} initialUnread={unreadAlertCount ?? 0} />
{/if}