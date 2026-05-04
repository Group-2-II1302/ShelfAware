import type { Actions } from "./$types";
import { fail } from "@sveltejs/kit";

export const actions: Actions = {
  saveExpiry: async ({ request, locals: { supabase } }) => {
    const formData = await request.formData();
    
    const expiry_date = formData.get("expiry_date") as string;
    const barcode = formData.get("barcode") as string;

    if (!expiry_date || !barcode) {
      return fail(400, { error: "Missing date or barcode" });
    }

    // 1. Format conversion: DD-MM-YYYY -> YYYY-MM-DD
    const [d, m, y] = expiry_date.split('-');
    const postgresDate = `${y}-${m}-${d}`;

    // 2. UPDATE existing row in shelf_items
    const { error } = await supabase
      .from('shelf_items')
      .update({ expiry_date: postgresDate })
      .eq('barcode', barcode); 

    if (error) {
      console.error("Supabase Error:", error.message);
      return fail(500, { error: "Database update failed" });
    }

    return { success: true };
  },
};