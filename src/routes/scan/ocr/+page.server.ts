import type { Actions } from "./$types";

export const actions: Actions = {
  saveExpiry: async ({ request }) => {
    try {
      const formData = await request.formData();
      const expiryDate = formData.get("expiry_date") as string;

      // ====== Mock Database Persistence ======
      // The terminal-logging
      console.log("\n--- MOCK DB SAVE (OCR) ---");
      console.table({
        type: "EXPIRY_SCAN",
        date: expiryDate,
        timestamp: new Date().toISOString(),
        status: "LOCAL_PERSISTENCE_VERIFIED",
      });
      console.log("--------------------------\n");

      return { success: true };
    } catch (err) {
      console.error("Action error:", err);
      return { success: false };
    }
  },
};
