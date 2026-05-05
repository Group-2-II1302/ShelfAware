import type { Actions, PageServerLoad } from "./$types";
import { fail } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ url, locals }) => {
    const { data: { session } } = await locals.supabase.auth.getSession();
    
    return {
        shelf_id: url.searchParams.get("shelf_id"),
        slot: url.searchParams.get("slot"),
        barcode: url.searchParams.get("barcode"),
        isAuthenticated: !!session
    };
};

export const actions: Actions = {
    saveExpiry: async ({ request, locals }) => {
        const { supabase } = locals;
        
        // 1. Authenticate user
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            return fail(401, { error: "Unauthorized. Please log in." });
        }

        const formData = await request.formData();
        
        const expiry_date = formData.get("expiry_date")?.toString().trim();
        const barcode = formData.get("barcode")?.toString().trim();
        const shelf_id = formData.get("shelf_id")?.toString().trim();
        const scale_index_raw = formData.get("scale_index")?.toString().trim();

        // 2. Strict validation
        if (!expiry_date || !barcode || !shelf_id || !scale_index_raw) {
            console.error("CRITICAL: Missing parameter context in form data submission.");
            return fail(400, { error: "Missing required parameter context." });
        }

        const scale_index = parseInt(scale_index_raw, 10);
        if (isNaN(scale_index) || scale_index < 0) {
            console.error(`CRITICAL: Invalid scale index parsed: ${scale_index_raw}`);
            return fail(400, { error: "Invalid slot scale index." });
        }

        // 3. Convert format: DD-MM-YYYY -> YYYY-MM-DD
        const parts = expiry_date.split('-');
        if (parts.length !== 3) {
            return fail(400, { error: "Date format must be DD-MM-YYYY." });
        }
        const [d, m, y] = parts;
        const postgresDate = `${y}-${m}-${d}`;

        // 4. Debug the exact types and variables we are querying with
        console.log("=== DB QUERY PARAMETERS & TYPES ===");
        console.log("shelf_id:", shelf_id, `(Type: ${typeof shelf_id})`);
        console.log("scale_index:", scale_index, `(Type: ${typeof scale_index})`);
        console.log("barcode:", barcode, `(Type: ${typeof barcode})`);
        console.log("postgresDate:", postgresDate, `(Type: ${typeof postgresDate})`);

        // 5. Final write for this flow: insert full slot item with expiry in one go.
        const { data: insertedRows, error: insertError } = await supabase
            .from("shelf_items")
            .insert({
                shelf_id,
                scale_index,
                barcode,
                expiry_date: postgresDate,
                updated_at: new Date().toISOString()
            })
            .select("id");

        if (insertError) {
            console.error("Database Insert Error:", insertError.message);
            return fail(500, { error: `Database Save Failed: ${insertError.message}` });
        }

        console.log("Database response (inserted rows):", insertedRows);

        // 6. Explicit check: ensure insert returned at least one row
        if (!insertedRows || insertedRows.length === 0) {
            console.error("Insert returned no rows.", { shelf_id, scale_index, barcode });
            return fail(404, {
                error:
                    "Could not insert shelf item. Please verify your RLS policy allows INSERT for this shelf membership."
            });
        }

        console.log("Database updated successfully!");
        return { success: true };
    },
};