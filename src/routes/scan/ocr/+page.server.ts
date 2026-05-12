import type { Actions, PageServerLoad } from "./$types";
import { fail } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ url, locals }) => {
  const {
    data: { session },
  } = await locals.supabase.auth.getSession();

  const shelf_id = url.searchParams.get("shelf_id");
  const slot = url.searchParams.get("slot");
  const barcode = url.searchParams.get("barcode");

  /*
    Resolve human-friendly labels for the page header so the user
    sees the shelf name and product name rather than raw UUIDs /
    barcodes. Both queries are cheap and tolerant of failure — if
    they can't resolve we just fall back to the raw value in the UI.
  */
  let shelfName: string | null = null;
  let productName: string | null = null;
  let productImage: string | null = null;

  if (session) {
    if (shelf_id) {
      const { data: shelf } = await locals.supabase
        .from("shelves")
        .select("name")
        .eq("id", shelf_id)
        .maybeSingle();
      shelfName = shelf?.name ?? null;
    }
    if (barcode) {
      const { data: prod } = await locals.supabase
        .from("product_catalog")
        .select("product_name, image_url")
        .eq("barcode", barcode)
        .maybeSingle();
      productName = prod?.product_name ?? null;
      productImage = prod?.image_url ?? null;
    }
  }

  return {
    shelf_id,
    slot,
    barcode,
    shelfName,
    productName,
    productImage,
    /*
      '1' when this OCR step is part of a replace flow (user came in
      from tapping a filled slot). The page forwards this through the
      form so saveExpiry can swap the existing shelf_items row.
    */
    replace: url.searchParams.get("replace") === "1",
    isAuthenticated: !!session,
  };
};

export const actions: Actions = {
  saveExpiry: async ({ request, locals }) => {
    const { supabase } = locals;

    // 1. Authenticate user
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return fail(401, { error: "Unauthorized. Please log in." });
    }

    const formData = await request.formData();

    const expiry_date = formData.get("expiry_date")?.toString().trim();
    const barcode = formData.get("barcode")?.toString().trim();
    const shelf_id = formData.get("shelf_id")?.toString().trim();
    const scale_index_raw = formData.get("scale_index")?.toString().trim();
    const replace = formData.get("replace")?.toString() === "1";

    // 2. Strict validation
    if (!expiry_date || !barcode || !shelf_id || !scale_index_raw) {
      console.error(
        "CRITICAL: Missing parameter context in form data submission.",
      );
      return fail(400, { error: "Missing required parameter context." });
    }

    const scale_index = parseInt(scale_index_raw, 10);
    if (isNaN(scale_index) || scale_index < 0) {
      console.error(`CRITICAL: Invalid scale index parsed: ${scale_index_raw}`);
      return fail(400, { error: "Invalid slot scale index." });
    }

    // 3. Convert format: DD-MM-YYYY -> YYYY-MM-DD
    const parts = expiry_date.split("-");
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
    console.log(
      "postgresDate:",
      postgresDate,
      `(Type: ${typeof postgresDate})`,
    );

    /*
      5. Final write for this flow.

      Replace mode: the user tapped an already-filled slot to swap its
      product. There's at most one row per (shelf_id, scale_index) by
      domain rules (one physical scale per slot), so we delete any
      existing row first and then insert the new one. We deliberately
      don't use upsert here because we don't want to keep stale columns
      (current_weight_g, expiry of the old product, etc.) — a
      replacement is conceptually a brand-new item on the slot.

      Add mode: straight insert as before. If RLS or a unique index
      rejects an insert because something is already there, the user
      should have been routed through replace mode instead.
    */
    if (replace) {
      /*
        Asking PostgREST to return the deleted rows (`.select()`) lets us
        distinguish "nothing matched" from "delete succeeded". If RLS
        silently filters us to zero rows the call still returns
        error:null — without this we'd cheerfully insert a duplicate.
      */
      const { data: deletedRows, error: deleteError } = await supabase
        .from("shelf_items")
        .delete()
        .eq("shelf_id", shelf_id)
        .eq("scale_index", scale_index)
        .select("id, barcode");

      if (deleteError) {
        console.error(
          "Database Delete Error during replace:",
          deleteError.message,
        );
        return fail(500, {
          error: `Could not clear existing slot: ${deleteError.message}`,
        });
      }

      console.log(
        `Replace: deleted ${deletedRows?.length ?? 0} existing row(s) for shelf=${shelf_id} slot=${scale_index}`,
        deletedRows,
      );

      if (!deletedRows || deletedRows.length === 0) {
        /*
          The user came in via the replace flow which only triggers from
          tapping a filled slot, so there must have been a row visible
          to them at page load. If we can't see it now, RLS is almost
          certainly hiding it from this server-side delete (e.g. policy
          requires shelf_members membership and we're using an anon
          client, or the delete policy is missing entirely).
        */
        return fail(500, {
          error:
            "Could not delete existing slot item. Check RLS DELETE policy on shelf_items.",
        });
      }
    }

    const { data: insertedRows, error: insertError } = await supabase
      .from("shelf_items")
      .insert({
        shelf_id,
        scale_index,
        barcode,
        expiry_date: postgresDate,
        updated_at: new Date().toISOString(),
      })
      .select("id");

    if (insertError) {
      console.error("Database Insert Error:", insertError.message);
      return fail(500, {
        error: `Database Save Failed: ${insertError.message}`,
      });
    }

    console.log("Database response (inserted rows):", insertedRows);

    // 6. Explicit check: ensure insert returned at least one row
    if (!insertedRows || insertedRows.length === 0) {
      console.error("Insert returned no rows.", {
        shelf_id,
        scale_index,
        barcode,
      });
      return fail(404, {
        error:
          "Could not insert shelf item. Please verify your RLS policy allows INSERT for this shelf membership.",
      });
    }

    console.log("Database updated successfully!");
    return { success: true };
  },
};
