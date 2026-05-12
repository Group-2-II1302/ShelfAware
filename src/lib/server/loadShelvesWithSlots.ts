import type { SupabaseClient } from "@supabase/supabase-js";
import { SLOTS_PER_SHELF, getZoneForSlot } from "$lib/shelf";
import { computeState } from "$lib/shelfState";

export type SlotSummary = {
  scale_index: number;
  zone: ReturnType<typeof getZoneForSlot>;
  status: "filled" | "empty";
  item: {
    id: string;
    barcode: string | null;
    product_name: string | null;
    current_weight_g: number | null;
    state: ReturnType<typeof computeState>;
  } | null;
};

export type ShelfSummary = {
  id: string;
  name: string;
};

/*
  Shared loader for "I need to pick a shelf + slot to scan into" flows.
  Returns the list of shelves the user can access and, for each shelf,
  a SLOTS_PER_SHELF-long array of slot summaries. Used by both
  /scan-item (the fallback picker) and /scan/barcode (the inline
  shelf/slot pill).
*/
export async function loadShelvesWithSlots(supabase: SupabaseClient) {
  const { data: shelves, error: shelvesError } = await supabase
    .from("shelves")
    .select("id, name")
    .order("created_at", { ascending: false });

  if (shelvesError) throw shelvesError;

  const shelfIds = (shelves ?? []).map((s) => s.id);

  if (shelfIds.length === 0) {
    return {
      shelves: [] as ShelfSummary[],
      slotsByShelf: {} as Record<string, SlotSummary[]>,
    };
  }

  const { data: items, error: itemsError } = await supabase
    .from("shelf_items")
    .select(
      `
      id,
      barcode,
      scale_index,
      shelf_id,
      current_weight_g,
      product_catalog (
        product_name,
        full_weight_g,
        tare_weight_g
      )
    `,
    )
    .in("shelf_id", shelfIds);

  if (itemsError) throw itemsError;

  const slotsByShelf: Record<string, SlotSummary[]> = {};

  for (const shelf of shelves ?? []) {
    const shelfItems = (items ?? []).filter((i) => i.shelf_id === shelf.id);
    const bySlot = new Map<number, SlotSummary["item"]>();

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
          catalog?.tare_weight_g ?? null,
        ),
      });
    }

    slotsByShelf[shelf.id] = Array.from({ length: SLOTS_PER_SHELF }, (_, i) => {
      const item = bySlot.get(i) ?? null;
      return {
        scale_index: i,
        zone: getZoneForSlot(i),
        status: item ? "filled" : "empty",
        item,
      } satisfies SlotSummary;
    });
  }

  return { shelves: shelves as ShelfSummary[], slotsByShelf };
}
