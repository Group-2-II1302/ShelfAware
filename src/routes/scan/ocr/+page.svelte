<script lang="ts">
    import { enhance } from '$app/forms';
    import { page } from '$app/state'; // Add this import
    import OcrScanner from '$lib/components/OcrScanner.svelte';

    let scannedDate = $state<string | null>(null);
    let isSaving = $state(false);
    let formElement = $state<HTMLFormElement | null>(null);

    // Get barcode from URL (e.g. ?barcode=fake_barcode_1)
    const barcode = page.url.searchParams.get('barcode') || '';

    const handleDateFound = (date: string) => {
        scannedDate = date;
        setTimeout(() => {
            formElement?.requestSubmit();
        }, 100);
    };

    function reset() {
        scannedDate = null;
        isSaving = false;
    }
</script>

<form 
        bind:this={formElement} 
        method="POST" 
        action="?/saveExpiry" 
        use:enhance={({ formData }) => {
            isSaving = true;
            if (scannedDate) {
                formData.set("expiry_date", scannedDate);
            }
            // Include the barcode in the submission
            formData.set("barcode", barcode);
            
            return async ({ result }) => {
                if (result.type === 'success') {
                    setTimeout(reset, 2000);
                } else {
                    isSaving = false;
                }
            };
        }}
        style="display: none;"
    >
    </form>