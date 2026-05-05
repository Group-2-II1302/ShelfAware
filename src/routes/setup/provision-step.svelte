<script lang="ts">
  import { setupState } from "../../lib/setup/stores";
  import { provisionPi } from "../../lib/pi";
  import { get } from "svelte/store";
  import { supabase } from "../../lib/supabaseClient";
  import ErrorBanner from "../../lib/components/ErrorBanner.svelte";

  let ssid = "";
  let password = "";

  async function submit() {
    if (!ssid.trim()) {
        setupState.update(s => ({
            ...s,
            error: "SSID is required"
        }));
        return;
    }

    setupState.update(s => ({
        ...s,
        loading: true,
        error: undefined
    }));

    try {
        const { data } = await supabase.auth.getUser();

        const state = get(setupState);

        const res = await provisionPi({
            ssid,
            password,
            user_id: data.user.id
        });

        setupState.update(s => ({
            ...s,
            shelfId: res.shelf_id,
            step: "connecting",
            loading: false
        }));
    } catch (e: any) {
        setupState.update(s => ({
            ...s,
            error:
                e?.message === "Already provisioned"
                ? "This device is already set up"
                : "Provisioning failed",
            loading: false
        }));
    }
  }
</script>

<ErrorBanner
  message={$setupState.error}
  action={{ type: "RETRY_PROVISION" }}
/>

<h2>Connect to Home WiFi</h2>

<input placeholder="SSID" bind:value={ssid} />
<input type="password" placeholder="Password" bind:value={password} />

<button on:click={submit} disabled={$setupState.loading}>
  {$setupState.loading ? "Connecting..." : "Connect"}
</button>