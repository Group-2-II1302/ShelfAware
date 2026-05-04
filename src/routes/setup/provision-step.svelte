<script lang="ts">
  import { setupState } from "../../lib/stores";
  import { provisionPi } from "../../lib/pi";
  import { get } from "svelte/store";
  import { supabase } from "../../lib/supabaseClient";

  let ssid = "";
  let password = "";
  let loading = false;
  let error = "";

  async function submit() {
    loading = true;
    const { data } = await supabase.auth.getUser();

    try {
      const state = get(setupState);

      const res = await provisionPi({
        ssid,
        password,
        user_id: data.user.id
      });

      setupState.update(s => ({
        ...s,
        shelfId: res.shelf_id,
        step: "connecting"
      }));
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }
</script>

<h2>Connect to Home WiFi</h2>

<input placeholder="SSID" bind:value={ssid} />
<input type="password" placeholder="Password" bind:value={password} />

<button on:click={submit} disabled={loading}>
  {loading ? "Connecting..." : "Connect"}
</button>

{#if error}<p>{error}</p>{/if}