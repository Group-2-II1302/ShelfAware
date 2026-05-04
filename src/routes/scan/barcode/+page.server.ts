import type { Actions } from "./$types";
import { fail } from "@sveltejs/kit";

export const actions: Actions = {
  saveProduct: async ({ request, locals: { supabase } }) => {
    const formData = await request.formData();
    const barcode = formData.get("barcode") as string;
    const product_name = formData.get("product_name") as string;

    if (!barcode || !product_name) {
      console.error("Save failed: Missing barcode or name");
      return fail(400, { error: "Missing data" });
    }

    // 1. Save to Product Catalog
    const { error: catError } = await supabase
      .from('product_catalog')
      .upsert({
        barcode,
        product_name,
        brand: formData.get("brand"),
        image_url: formData.get("image_url"),
        full_weight_g: parseFloat(formData.get("full_weight_g") as string) || 0,
        unit: 'g'
      }, { onConflict: 'barcode' });

    if (catError) {
      console.error("Catalog Error:", catError.message);
      return fail(500, { error: catError.message });
    }

    // 2. Initialize the item on the shelf
    const { error: itemError } = await supabase
      .from('shelf_items')
      .upsert({ barcode }, { onConflict: 'barcode' });

    if (itemError) {
      console.error("Shelf Error:", itemError.message);
      return fail(500, { error: itemError.message });
    }

    console.log("Save successful for barcode:", barcode);
    return { success: true };
  },
};