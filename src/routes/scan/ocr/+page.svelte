<script lang="ts">
    import { enhance } from '$app/forms';
    import OcrScanner from '$lib/components/OcrScanner.svelte';

    let scannedDate = $state<string | null>(null);
    let isSaving = $state(false);
    let formElement = $state<HTMLFormElement | null>(null);

    const handleDateFound = (date: string) => {
        // We set the state to show the success UI
        scannedDate = date;
        
        // We trigger the form submit immediately
        // setTimeout ensures the UI has switched to the "Success" state first
        setTimeout(() => {
            formElement?.requestSubmit();
        }, 100);
    };

    function reset() {
        scannedDate = null;
        isSaving = false;
    }
</script>

<div class="page-layout">
    <h1>Expiry Date Scanner</h1>

    {#if !scannedDate}
        <OcrScanner ondatefound={handleDateFound} />
    {:else}
        <div class="success-state">
            <h2 class="success-title">Success!</h2>
            <p>Detected Date: <strong>{scannedDate}</strong></p>
            <p>{isSaving ? 'Syncing to database...' : 'Saved!'}</p>
        </div>
    {/if}

    <form 
        bind:this={formElement} 
        method="POST" 
        action="?/saveExpiry" 
        use:enhance={({ formData }) => {
            isSaving = true;
            // Manually append the date to the form submission
            if (scannedDate) {
                formData.set("expiry_date", scannedDate);
            }
            
            return async ({ result }) => {
                if (result.type === 'success') {
                    // Wait 2 seconds so the user can see the success message
                    setTimeout(reset, 2000);
                } else {
                    isSaving = false;
                }
            };
        }}
        style="display: none;"
    >
    </form>
</div>

<style>
    /* Adding a quick style for the success message */
    .success-state {
        text-align: center;
        padding: 2rem;
        background: #ecfdf5;
        border: 2px solid #10b981;
        border-radius: 12px;
        margin-top: 2rem;
    }
    .success-title {
        color: #059669;
        margin-top: 0;
    }
</style>