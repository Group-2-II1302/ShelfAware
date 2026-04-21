<script lang="ts">
    import { enhance } from '$app/forms';
    import BarcodeScanner from '$lib/components/BarcodeScanner.svelte';
    
    type ProductCatalogEntry = {
        barcode: string;
        product_name: string;
        brand: string;
        image_url: string;
        full_weight_g: number;
    };

    let foundProduct = $state<ProductCatalogEntry | null>(null);
    let isFetching = $state(false);
    let errorMessage = $state<string | null>(null);
    let formElement = $state<HTMLFormElement | null>(null);
    let currentScanId = 0;

    $effect(() => {
        if (foundProduct && !isFetching) {
            setTimeout(() => { formElement?.requestSubmit(); }, 50);
        }
    });

    // Explicitly typing as (barcode: string) => Promise<void>
    const handleScan = async (barcode: string): Promise<void> => {
        const scanId = ++currentScanId;
        isFetching = true;
        errorMessage = null;

        try {
            const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
            const data = await res.json();

            if (scanId !== currentScanId) return;

            if (data.status === 1 && data.product) {
                const p = data.product;
                foundProduct = {
                    barcode: data.code,
                    product_name: p.product_name || p.generic_name || 'Unknown',
                    brand: p.brands || 'Unknown',
                    image_url: p.image_front_url || '',
                    full_weight_g: Number(p.net_weight_value || p.product_quantity || 0)
                };
            } else {
                errorMessage = "Product not found.";
            }
        } catch (e) {
            if (scanId === currentScanId) errorMessage = "Network error.";
        } finally {
            if (scanId === currentScanId) isFetching = false;
        }
    };

    function reset() {
        foundProduct = null;
        errorMessage = null;
        isFetching = false;
    }
</script>

<div class="scan-page">
    {#if !foundProduct && !isFetching}
        <BarcodeScanner onscan={handleScan} />
    {/if}

    {#if isFetching || foundProduct}
        <p>{isFetching ? 'Fetching...' : 'Saving...'}</p>
    {/if}

    <form 
        bind:this={formElement} 
        method="POST" 
        action="?/saveProduct" 
        use:enhance={() => {
            return async ({ result }) => {
                if (result.type === 'success') reset();
            };
        }}
        style="display: none;"
    >
        <input type="hidden" name="barcode" value={foundProduct?.barcode} />
        <input type="hidden" name="product_name" value={foundProduct?.product_name} />
        <input type="hidden" name="brand" value={foundProduct?.brand} />
        <input type="hidden" name="image_url" value={foundProduct?.image_url} />
        <input type="hidden" name="full_weight_g" value={foundProduct?.full_weight_g} />
    </form>
</div>