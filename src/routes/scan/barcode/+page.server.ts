import type { Actions } from "./$types";

export const actions: Actions = {
  saveProduct: async ({ request }) => {
    try {
      const formData = await request.formData();

      // Normalise data for the console log
      const product = {
        barcode: formData.get("barcode") as string,
        product_name: formData.get("product_name") as string,
        brand: formData.get("brand") as string,
        image_url: formData.get("image_url") as string,
        full_weight_g: Number(formData.get("full_weight_g")) || 0,
      };

      // Log to your WSL terminal so you can see it working
      console.log("--- MOCK DB SAVE ---");
      console.table(product);

      // Return success to the frontend
      return { success: true };
    } catch (err) {
      console.error("Action error:", err);
      return { success: false, error: "Server exploded" };
    }
  },
};
