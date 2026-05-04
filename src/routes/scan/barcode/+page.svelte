<script lang="ts">
    import { enhance } from '$app/forms';
    import { goto } from '$app/navigation';
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
    let isSaving = $state(false);
    let formElement = $state<HTMLFormElement | null>(null);

    const handleManualSave = (manualData: any) => {
        foundProduct = {
            barcode: manualData.barcode,
            product_name: manualData.product_name,
            brand: manualData.brand || 'Generic',
            image_url: manualData.image_url || '',
            full_weight_g: manualData.full_weight_g || 0
        };
    };

    $effect(() => {
        if (foundProduct && !isFetching && !isSaving) {
            setTimeout(() => { formElement?.requestSubmit(); }, 50);
        }
    });

    const handleScan = async (barcode: string) => {
        isFetching = true;
        try {
            const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
            const data = await res.json();
            if (data.status === 1) {
                const p = data.product;
                foundProduct = {
                    barcode: data.code,
                    product_name: p.product_name || 'Unknown',
                    brand: p.brands || 'Unknown',
                    image_url: p.image_front_url || '',
                    full_weight_g: Number(p.net_weight_value || 0)
                };
            } else {
                // If not in OpenFoodFacts, go to manual entry with just the barcode
                foundProduct = { barcode, product_name: '', brand: '', image_url: '', full_weight_g: 0 };
            }
        } catch (e) {
            console.error(e);
        } finally {
            isFetching = false;
        }
    };
</script>

<div class="scan-page">
    {#if !foundProduct && !isFetching}
        <BarcodeScanner onscan={handleScan} onManualSave={handleManualSave} />
    {/if}

    {#if isFetching || isSaving || foundProduct}
        <div style="text-align: center; padding: 2rem;">
            <p>{isFetching ? 'Searching Catalog...' : 'Saving to Shelf...'}</p>
        </div>
    {/if}

    <form 
        bind:this={formElement} 
        method="POST" 
        action="?/saveProduct" 
        use:enhance={() => {
            isSaving = true;
            return async ({ result }) => {
                if (result.type === 'success') {
                    // ONLY navigate once we know the DB is updated
                    goto(`/scan/ocr?barcode=${foundProduct?.barcode}`);
                }
                isSaving = false;
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