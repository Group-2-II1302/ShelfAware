<script lang="ts">
    import { setupState } from "../../lib/setup/stores";
    import ConnectingStep from "./connecting-step.svelte";
    import SuccessStep from "./success-step.svelte";
    import ErrorBanner from "../../lib/components/ErrorBanner.svelte";
    import { waitForNewShelf } from "$lib/setup/waitForNewShelf";
    import { goto } from "$app/navigation";
    import { onMount, onDestroy } from "svelte";

    let controller: AbortController | null = null;

    /*
      The setup store lives at module scope, so navigating away
      mid-poll and coming back would otherwise leave the page stuck
      in "waiting" with no live poller behind it. Reset on mount
      so we always start from a clean idle state.
    */
    onMount(() => {
        setupState.set({ step: "idle", shelfId: undefined, error: undefined });
    });

    async function startSetup() {

        controller?.abort();

        controller = new AbortController();

        setupState.set({
            step: "waiting",
            shelfId: undefined,
            error: undefined
        });

        try {
            const shelfId = await waitForNewShelf(controller.signal);

            setupState.set({
                step: "success",
                shelfId,
                error: undefined
            });

        } catch (e: any) {

            if (e.name === "AbortError") {
                return;
            }

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

    onDestroy(() => {
        controller?.abort();
    });
</script>

{#if $setupState.step === "idle"}
    <div>
        <h2>How to set up your device</h2>
        <div>
            <div>
                1. Plug in your device to a power source.
            </div>
            <div>
                2. Connect to your device's WiFi hot spot: "ShelfAware_setup".
            </div>
            <div>
                3. Open the <a href="http://192.168.4.1" target="_blank" rel="noopener noreferrer" onclick={startSetup}>device page</a>.
            </div>
            <div>
                4. Fill in the relevant information.
            </div>
    </div>
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