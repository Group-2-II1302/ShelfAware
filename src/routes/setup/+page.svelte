<script lang="ts">
    import { setupState } from "../../lib/setup/stores";
    import ConnectingStep from "./connecting-step.svelte";
    import SuccessStep from "./success-step.svelte";
    import ErrorBanner from "../../lib/components/ErrorBanner.svelte";
    import { waitForNewShelf } from "$lib/setup/waitForNewShelf";
    import { goto } from "$app/navigation";

    async function startSetup() {
        setupState.set({
            step: "waiting",
            shelfId: undefined,
            error: undefined
        });

        const setupStartedAt = Date.now();

        try {
            const shelfId = await waitForNewShelf(setupStartedAt);

            setupState.set({
                step: "success",
                shelfId,
                error: undefined
            });

            goto(`/shelves/${shelfId}`);
        } catch (e: any) {
            setupState.set({
                step: "error",
                shelfId: undefined,
                error: e.message
            });
        }
    }

    function handleFinish() {
        if(!$setupState.shelfId) {
            console.error("Missing shelfId");
            return;
        }

        goto(`/shelves/${$setupState.shelfId}`);
    }

</script>

{#if $setupState.step === "idle"}
    <div>
        <h2>Set up your device</h2>
        <p>
        1. Connect to <b>ShelfAware_Setup</b> WiFi<br />
        2. Open <b>http://192.168.4.1</b> in your browser<br />
        3. Complete setup on the device page
        </p>

        <button
        onclick={startSetup}>
            I've completed setup
        </button>
    </div>
{:else if $setupState.step === "waiting"}
  <ConnectingStep />
{:else if $setupState.step === "success"}
  <SuccessStep onFinish={handleFinish}/>
{:else if $setupState.step === "error"}
    {#if $setupState.error}
        <ErrorBanner message={$setupState.error} />
    {/if}
    <button onclick={startSetup}>Try Again</button>
{/if}