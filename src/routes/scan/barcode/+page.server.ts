import type { Actions, PageServerLoad } from "./$types";
import { fail, redirect } from "@sveltejs/kit";

/**
 * Ensures the page has the context required by the Shelves Contract.
 * Uses the standard client authentication check.
 */
export const load: PageServerLoad = async ({ url, locals }) => {
    const shelf_id = url.searchParams.get("shelf_id");
    const slot = url.searchParams.get("slot");

    // Fallback safe check: Get the user session using the standard auth helper
    const { data: { session } } = await locals.supabase.auth.getSession();

    return {
        shelf_id,
        slot,
        isAuthenticated: !!session
    };
};

export const actions: Actions = {
    saveProduct: async ({ request, locals }) => {
        // Authenticated client carrying the user's JWT
        const { supabase } = locals;
        
        // Double-check authentication for safety
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            return fail(401, { error: "Unauthorized. Please log in first." });
        }

        const formData = await request.formData();

        // 1. Extraction & Sanitization
        const barcode = formData.get("barcode")?.toString().trim();
        const product_name = formData.get("product_name")?.toString().trim();
        const brand = formData.get("brand")?.toString().trim() || null;
        const image_url = formData.get("image_url")?.toString().trim() || null;
        const full_weight_g_raw = formData.get("full_weight_g")?.toString();
        const shelf_id = formData.get("shelf_id")?.toString().trim();
        const scale_index_raw = formData.get("scale_index")?.toString();

        // 2. The "Shelves Contract" Guard Clauses
        if (!barcode || !product_name) {
            return fail(400, { error: "Barcode and Product Name are mandatory." });
        }
        if (!shelf_id || !scale_index_raw) {
            return fail(400, { error: "Context missing: shelf_id or slot (scale_index) not provided." });
        }

        const scale_index = parseInt(scale_index_raw, 10);
        const full_weight_g = parseFloat(full_weight_g_raw || "0") || 0;

        if (isNaN(scale_index) || scale_index < 0) {
            return fail(400, { error: "Invalid scale_index. Must be a non-negative integer." });
        }

        // 3. STEP 1: Upsert to product_catalog (Global Metadata)
        const { error: catError } = await supabase
            .from("product_catalog")
            .upsert(
                {
                    barcode,
                    product_name,
                    brand,
                    image_url,
                    full_weight_g,
                    unit: "g",
                },
                { onConflict: "barcode" }
            );

        if (catError) {
            console.error("Schema or RLS Error in product_catalog:", catError.message);
            return fail(500, { error: `Catalog Save Failed: ${catError.message}` });
        }

        // 4. Do not write shelf_items yet.
        // The OCR step will do one final insert with both barcode and expiry date.
        throw redirect(
            303, 
            `/scan/ocr?shelf_id=${encodeURIComponent(shelf_id)}&slot=${encodeURIComponent(scale_index)}&barcode=${encodeURIComponent(barcode)}`
        );
    },
};