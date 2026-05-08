import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { SLOTS_PER_SHELF, getZoneForSlot } from "$lib/shelf";
import { computeState } from "$lib/shelfState";

export const load: PageServerLoad = async ({ locals }) => {
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user) throw redirect(303, "/login");

  // 1. shelves
  const { data: shelves, error: shelvesError } = await locals.supabase
    .from("shelves")
    .select("id, name")
    .order("created_at", { ascending: false });

  if (shelvesError) throw error(500, shelvesError.message);

  const shelfIds = shelves?.map(s => s.id) ?? [];

  // 2. items
  const { data: items, error: itemsError } = await locals.supabase
    .from("shelf_items")
    .select(`
      id,
      barcode,
      expiry_date,
      scale_index,
      shelf_id,
      current_weight_g,
      product_catalog (
        product_name,
        full_weight_g,
        tare_weight_g
      )
    `)
    .in("shelf_id", shelfIds);

  if (itemsError) throw error(500, itemsError.message);

  // 3. SAFE GROUPING BY SHELF
  const slotsByShelf: Record<string, any[]> = {};

  for (const shelf of shelves ?? []) {
    const shelfItems = (items ?? []).filter(
      i => i.shelf_id === shelf.id
    );

    const bySlot = new Map<number, any>();

    for (const item of shelfItems) {
      const catalog = Array.isArray(item.product_catalog)
        ? item.product_catalog[0]
        : item.product_catalog;

      bySlot.set(item.scale_index, {
        id: item.id,
        barcode: item.barcode,
        product_name: catalog?.product_name ?? null,
        current_weight_g: item.current_weight_g,
        state: computeState(
          item.current_weight_g ?? null,
          catalog?.full_weight_g ?? null,
          catalog?.tare_weight_g ?? null
        ),
      });
    }

    const slots = Array.from({ length: SLOTS_PER_SHELF }, (_, i) => {
      const item = bySlot.get(i);

      return {
        scale_index: i,
        zone: getZoneForSlot(i),
        status: item ? "filled" : "empty",
        item: item ?? null,
      };
    });

    slotsByShelf[shelf.id] = slots;
  }

  return {
    shelves: shelves ?? [],
    slotsByShelf,
  };
};