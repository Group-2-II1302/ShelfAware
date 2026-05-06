import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { SLOTS_PER_SHELF, getZoneForSlot, type ZoneId } from "$lib/shelf";
import { computeState } from "$lib/shelfState";

type FilledSlot = {
  scale_index: number;
  zone: ZoneId;
  status: "filled";
  item: {
    id: string;
    barcode: string;
    expiry_date: string | null;
    product_name: string | null;
    current_weight_g: number | null;
    /**
     * Recomputed-on-the-fly fullness from current_weight_g and the
     * joined product_catalog (full_weight_g / tare_weight_g). Null when
     * full_weight_g is missing — render as "Not calibrated".
     */
    state: number | null;
  };
};

type EmptySlot = {
  scale_index: number;
  zone: ZoneId;
  status: "empty";
};

export type ShelfSlot = FilledSlot | EmptySlot;

export const load: PageServerLoad = async ({ locals, params }) => {
  const shelfId = params.shelf_id;
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user) {
    throw redirect(303, "/login");
  }

  /*
    Verify user belongs to this shelf
  */
  const { data: membership, error: membershipError } = await locals.supabase
    .from("shelf_members")
    .select("id")
    .eq("user_id", user.id)
    .eq("shelf_id", shelfId)
    .maybeSingle();

  if (membershipError) {
    throw error(500, membershipError.message);
  }

  if (!membership) {
    throw error(403, "Shelf access denied");
  }

  /*
    Load shelf metadata
  */
  const { data: shelf, error: shelfError } = await locals.supabase
    .from("shelves")
    .select("id, name")
    .eq("id", shelfId)
    .single();

  if (shelfError) {
    throw error(500, shelfError.message);
  }

  /*
    Load shelf items + product names + calibration weights.
    shelf_items.barcode → product_catalog.barcode

    We pull full_weight_g and tare_weight_g so we can recompute the
    `state` (fullness ratio) per slot at request time. Backend may
    later mirror state onto shelf_items; if/when that lands we can
    drop the recompute.
  */
  const { data: items, error: itemsError } = await locals.supabase
    .from("shelf_items")
    .select(
      `
        id,
        barcode,
        expiry_date,
        scale_index,
        current_weight_g,
        product_catalog (
          product_name,
          full_weight_g,
          tare_weight_g
        )
      `,
    )
    .eq("shelf_id", shelfId)
    .order("created_at", { ascending: true });

  if (itemsError) {
    throw error(500, itemsError.message);
  }

  /*
    Build a fixed-length slot grid keyed by scale_index. The hardware
    layout is constant (see $lib/shelf), so we know how many slots to
    render up front; missing scale_index values render as empty slots.

    If two items share a scale_index (shouldn't happen, but defensively),
    the first one returned by the ordered query above wins.
  */
  type CatalogJoin = {
    product_name: string;
    full_weight_g: number | null;
    tare_weight_g: number | null;
  };

  const itemBySlot = new Map<number, FilledSlot["item"]>();
  for (const item of items ?? []) {
    if (itemBySlot.has(item.scale_index)) {
      continue;
    }
    /*
      PostgREST returns the joined product_catalog as either a single
      object or an array depending on the relationship metadata, so
      handle both shapes.
    */
    const rawCatalog = item.product_catalog as
      | CatalogJoin
      | CatalogJoin[]
      | null;
    const catalog = Array.isArray(rawCatalog)
      ? (rawCatalog[0] ?? null)
      : rawCatalog;

    const currentWeightG = item.current_weight_g ?? null;
    const state = computeState(
      currentWeightG,
      catalog?.full_weight_g ?? null,
      catalog?.tare_weight_g ?? null,
    );

    itemBySlot.set(item.scale_index, {
      id: item.id,
      barcode: item.barcode,
      expiry_date: item.expiry_date,
      product_name: catalog?.product_name ?? null,
      current_weight_g: currentWeightG,
      state,
    });
  }

  const slots: ShelfSlot[] = Array.from({ length: SLOTS_PER_SHELF }, (_, i) => {
    const filled = itemBySlot.get(i);
    const zone = getZoneForSlot(i);
    if (filled) {
      return { scale_index: i, zone, status: "filled", item: filled };
    }
    return { scale_index: i, zone, status: "empty" };
  });

  return {
    shelf,
    slots,
  };
};
