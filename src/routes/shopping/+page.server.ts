import { fail, redirect, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/*
  Shopping list page.

  Scoping model: a user's "household" is approximated by the set of shelves
  they're a member of. Every shopping_list_items row carries a shelf_id for
  RLS, but the UI presents the union of all rows across all of those
  shelves as one logical list. The user picks no shelf when adding a manual
  item; the server attaches the row to their *primary* shelf (first one
  ordered by name) so it lives somewhere predictable. When the household
  table lands later we'll backfill `household_id` and drop this proxy.
*/

const EXPIRY_WINDOW_DAYS = 7;
const SUGGESTION_LIMIT = 40;

type ShoppingRow = {
  id: string;
  shelf_id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  source_item_id: string | null;
  source_reason: "manual" | "low_stock" | "expiring" | "expired";
  checked_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

type Suggestion = {
  sourceItemId: string;
  reason: "low_stock" | "expiring" | "expired";
  name: string;
  brand: string | null;
  imageUrl: string | null;
  shelfId: string;
  shelfName: string;
  scaleIndex: number | null;
  /** Days to expiry (negative if expired). Null when reason !== expiring/expired. */
  daysToExpiry: number | null;
  /** Current weight in grams. Null when unknown. */
  currentWeightG: number | null;
  thresholdG: number | null;
};

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends("app:shopping");

  const {
    data: { user },
  } = await locals.supabase.auth.getUser();
  if (!user) throw redirect(303, "/login");

  /*
    Membership graph → set of shelves this user can see, used as the
    "household". Anything keyed to one of these shelves is in scope.
  */
  const { data: shelves, error: shelvesErr } = await locals.supabase
    .from("shelves")
    .select("id, name")
    .order("name", { ascending: true });

  if (shelvesErr) {
    console.error("[shopping] failed to load shelves", shelvesErr);
  }

  const shelfList = (shelves ?? []) as { id: string; name: string }[];
  const shelfIds = shelfList.map((s) => s.id);
  const shelfNameById = new Map(shelfList.map((s) => [s.id, s.name]));
  const primaryShelfId = shelfList[0]?.id ?? null;

  if (shelfIds.length === 0) {
    return {
      items: [] as ShoppingRow[],
      suggestions: [] as Suggestion[],
      primaryShelfId: null as string | null,
      hasShelves: false,
    };
  }

  /*
    Fetch every shopping list row + every potentially-relevant shelf_item
    + every dismissal in parallel. Three independent reads; no point
    serialising them.
  */
  type DismissalRow = {
    source_item_id: string;
    source_reason: "low_stock" | "expiring" | "expired";
  };

  type ShelfItemRow = {
    id: string;
    shelf_id: string;
    scale_index: number;
    barcode: string;
    expiry_date: string | null;
    current_weight_g: number | null;
    low_stock_threshold_g: number | null;
    product_catalog:
      | {
          product_name: string | null;
          brand: string | null;
          image_url: string | null;
        }
      | {
          product_name: string | null;
          brand: string | null;
          image_url: string | null;
        }[]
      | null;
  };

  const [itemsRes, shelfItemsRes, dismissalsRes] = await Promise.all([
    locals.supabase
      .from("shopping_list_items")
      .select(
        "id, shelf_id, name, quantity, unit, source_item_id, source_reason, checked_at, position, created_at, updated_at",
      )
      .in("shelf_id", shelfIds)
      .order("checked_at", { ascending: true, nullsFirst: true })
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    locals.supabase
      .from("shelf_items")
      .select(
        "id, shelf_id, scale_index, barcode, expiry_date, current_weight_g, low_stock_threshold_g, product_catalog(product_name, brand, image_url)",
      )
      .in("shelf_id", shelfIds),
    locals.supabase
      .from("shopping_list_dismissals")
      .select("source_item_id, source_reason")
      .eq("user_id", user.id),
  ]);

  if (itemsRes.error) {
    console.error("[shopping] failed to load items", itemsRes.error);
  }
  if (shelfItemsRes.error) {
    console.error("[shopping] failed to load shelf items", shelfItemsRes.error);
  }
  if (dismissalsRes.error) {
    console.error(
      "[shopping] failed to load dismissals",
      dismissalsRes.error,
    );
  }

  const items = (itemsRes.data ?? []) as unknown as ShoppingRow[];
  const shelfItems = (shelfItemsRes.data ?? []) as unknown as ShelfItemRow[];
  const dismissals = (dismissalsRes.data ?? []) as DismissalRow[];

  /*
    Build a fast lookup of "this (source_item_id, reason) already lives on
    the user's list" so we can skip suggesting it. Manual rows have null
    source_item_id; they're never deduped against suggestions.
  */
  const onListKeys = new Set<string>();
  for (const row of items) {
    if (row.source_item_id) {
      onListKeys.add(`${row.source_item_id}:${row.source_reason}`);
    }
  }

  const dismissedKeys = new Set<string>();
  for (const d of dismissals) {
    dismissedKeys.add(`${d.source_item_id}:${d.source_reason}`);
  }

  /*
    Derive suggestions from shelf_items. A single shelf_item can produce
    up to two suggestions (e.g. expiring AND low_stock); we surface each
    distinct reason as its own suggestion so users can act on (or dismiss)
    them independently.
  */
  const todayMs = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const suggestions: Suggestion[] = [];

  for (const row of shelfItems) {
    const cat = Array.isArray(row.product_catalog)
      ? row.product_catalog[0]
      : row.product_catalog;
    const name = cat?.product_name || row.barcode || "Item";
    const shelfName = shelfNameById.get(row.shelf_id) ?? "Shelf";

    const base = {
      sourceItemId: row.id,
      name,
      brand: cat?.brand ?? null,
      imageUrl: cat?.image_url ?? null,
      shelfId: row.shelf_id,
      shelfName,
      scaleIndex: row.scale_index ?? null,
      currentWeightG: row.current_weight_g,
      thresholdG: row.low_stock_threshold_g,
    };

    /*
      Expiry-driven suggestions: anything within EXPIRY_WINDOW_DAYS, with
      already-expired surfacing as a separate "expired" reason so the UI
      can colour it red. Items missing an expiry_date don't qualify.
    */
    if (row.expiry_date) {
      const days = Math.ceil(
        (new Date(row.expiry_date).getTime() - todayMs) / 86_400_000,
      );
      if (days <= EXPIRY_WINDOW_DAYS) {
        const reason: Suggestion["reason"] = days < 0 ? "expired" : "expiring";
        const key = `${row.id}:${reason}`;
        if (!onListKeys.has(key) && !dismissedKeys.has(key)) {
          suggestions.push({
            ...base,
            reason,
            daysToExpiry: days,
          });
        }
      }
    }

    /*
      Low-stock suggestions: same predicate as the dashboard ("Now" list),
      so users see a consistent set of items eligible for the shopping
      list across surfaces.
    */
    if (
      row.low_stock_threshold_g !== null &&
      row.current_weight_g !== null &&
      row.current_weight_g <= row.low_stock_threshold_g
    ) {
      const key = `${row.id}:low_stock`;
      if (!onListKeys.has(key) && !dismissedKeys.has(key)) {
        suggestions.push({
          ...base,
          reason: "low_stock",
          daysToExpiry: null,
        });
      }
    }
  }

  /*
    Order: expired (most urgent) → expiring (soonest first) → low_stock
    (most empty first). Mirrors the priorities used elsewhere in the app.
  */
  const reasonRank: Record<Suggestion["reason"], number> = {
    expired: 0,
    expiring: 1,
    low_stock: 2,
  };
  suggestions.sort((a, b) => {
    if (reasonRank[a.reason] !== reasonRank[b.reason]) {
      return reasonRank[a.reason] - reasonRank[b.reason];
    }
    if (a.reason === "expiring" || a.reason === "expired") {
      return (
        (a.daysToExpiry ?? Number.POSITIVE_INFINITY) -
        (b.daysToExpiry ?? Number.POSITIVE_INFINITY)
      );
    }
    return (
      (a.currentWeightG ?? Number.POSITIVE_INFINITY) -
      (b.currentWeightG ?? Number.POSITIVE_INFINITY)
    );
  });

  return {
    items,
    suggestions: suggestions.slice(0, SUGGESTION_LIMIT),
    primaryShelfId,
    hasShelves: true,
  };
};

/*
  Form actions. All of them rely on RLS to gate access — we only check
  authentication here and let the database refuse anything the user isn't
  a member of.
*/
export const actions: Actions = {
  addItem: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const name = (form.get("name")?.toString() ?? "").trim();
    const shelfId = form.get("shelf_id")?.toString() ?? "";
    const quantityRaw = form.get("quantity")?.toString().trim() ?? "";
    const unit = (form.get("unit")?.toString().trim() ?? "") || null;

    if (!name) {
      return fail(400, { addItem: { error: "Name is required" } });
    }
    if (!shelfId) {
      return fail(400, {
        addItem: { error: "Add a shelf before creating a list" },
      });
    }
    const quantity = quantityRaw ? Number(quantityRaw) : null;
    if (quantityRaw && Number.isNaN(quantity)) {
      return fail(400, { addItem: { error: "Quantity must be a number" } });
    }

    /*
      New items go to the end of the unchecked list. We compute the next
      position as max(position) + 1 over unchecked rows; doubles are fine
      because the next reorder will rewrite a clean sequence.
    */
    const { data: tail } = await locals.supabase
      .from("shopping_list_items")
      .select("position")
      .eq("shelf_id", shelfId)
      .is("checked_at", null)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextPosition = (tail?.position ?? 0) + 1;

    const { error } = await locals.supabase
      .from("shopping_list_items")
      .insert({
        shelf_id: shelfId,
        name,
        quantity,
        unit,
        source_reason: "manual",
        position: nextPosition,
      });

    if (error) {
      console.error("[shopping] addItem failed", error);
      return fail(500, { addItem: { error: error.message } });
    }
    return { addItem: { success: true } };
  },

  toggleChecked: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const id = form.get("id")?.toString();
    const checked = form.get("checked")?.toString() === "true";
    if (!id) return fail(400, { error: "Missing id" });

    const { error } = await locals.supabase
      .from("shopping_list_items")
      .update({ checked_at: checked ? new Date().toISOString() : null })
      .eq("id", id);

    if (error) {
      console.error("[shopping] toggleChecked failed", error);
      return fail(500, { error: error.message });
    }
    return { success: true };
  },

  renameItem: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const id = form.get("id")?.toString();
    const name = (form.get("name")?.toString() ?? "").trim();
    const quantityRaw = (form.get("quantity")?.toString() ?? "").trim();
    const unit = (form.get("unit")?.toString() ?? "").trim() || null;

    if (!id) return fail(400, { error: "Missing id" });
    if (!name) return fail(400, { rename: { error: "Name is required" } });

    const quantity = quantityRaw ? Number(quantityRaw) : null;
    if (quantityRaw && Number.isNaN(quantity)) {
      return fail(400, { rename: { error: "Quantity must be a number" } });
    }

    const { error } = await locals.supabase
      .from("shopping_list_items")
      .update({ name, quantity, unit })
      .eq("id", id);

    if (error) {
      console.error("[shopping] renameItem failed", error);
      return fail(500, { rename: { error: error.message } });
    }
    return { rename: { success: true } };
  },

  deleteItem: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const id = form.get("id")?.toString();
    if (!id) return fail(400, { error: "Missing id" });

    const { error } = await locals.supabase
      .from("shopping_list_items")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[shopping] deleteItem failed", error);
      return fail(500, { error: error.message });
    }
    return { success: true };
  },

  /*
    Reorder: client sends a comma-separated list of ids in their new
    order (unchecked rows only). We rewrite `position` as the 1-based
    index so the sequence stays clean. One round-trip per row but they
    fan out — Supabase batching would be nicer if the lists ever
    routinely contained dozens.
  */
  reorder: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const idsRaw = form.get("ids")?.toString() ?? "";
    const ids = idsRaw.split(",").filter(Boolean);
    if (ids.length === 0) return { success: true };

    const updates = await Promise.all(
      ids.map((id, idx) =>
        locals.supabase
          .from("shopping_list_items")
          .update({ position: idx + 1 })
          .eq("id", id),
      ),
    );

    for (const u of updates) {
      if (u.error) {
        console.error("[shopping] reorder partial failure", u.error);
        return fail(500, { error: u.error.message });
      }
    }
    return { success: true };
  },

  clearChecked: async ({ locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const { error } = await locals.supabase
      .from("shopping_list_items")
      .delete()
      .not("checked_at", "is", null);

    if (error) {
      console.error("[shopping] clearChecked failed", error);
      return fail(500, { error: error.message });
    }
    return { success: true };
  },

  /*
    Promote a suggestion onto the list. We rely on the partial unique
    index on (source_item_id, source_reason) to defend against double-
    clicks racing the realtime echo; a duplicate insert returns 23505
    which we swallow as "already added, no-op".
  */
  addFromSource: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const sourceItemId = form.get("source_item_id")?.toString();
    const reason = form.get("source_reason")?.toString();
    const name = (form.get("name")?.toString() ?? "").trim();
    const shelfId = form.get("shelf_id")?.toString();

    if (!sourceItemId || !reason || !name || !shelfId) {
      return fail(400, { error: "Missing suggestion fields" });
    }
    if (!["low_stock", "expiring", "expired"].includes(reason)) {
      return fail(400, { error: "Invalid reason" });
    }

    const { data: tail } = await locals.supabase
      .from("shopping_list_items")
      .select("position")
      .eq("shelf_id", shelfId)
      .is("checked_at", null)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextPosition = (tail?.position ?? 0) + 1;

    const { error } = await locals.supabase
      .from("shopping_list_items")
      .insert({
        shelf_id: shelfId,
        name,
        source_item_id: sourceItemId,
        source_reason: reason,
        position: nextPosition,
      });

    if (error && error.code !== "23505") {
      console.error("[shopping] addFromSource failed", error);
      return fail(500, { error: error.message });
    }
    return { success: true };
  },

  dismissSuggestion: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const form = await request.formData();
    const sourceItemId = form.get("source_item_id")?.toString();
    const reason = form.get("source_reason")?.toString();
    if (!sourceItemId || !reason) {
      return fail(400, { error: "Missing fields" });
    }

    const { error } = await locals.supabase
      .from("shopping_list_dismissals")
      .insert({ source_item_id: sourceItemId, source_reason: reason });

    // 23505 = already dismissed; treat as success.
    if (error && error.code !== "23505") {
      console.error("[shopping] dismissSuggestion failed", error);
      return fail(500, { error: error.message });
    }
    return { success: true };
  },

  clearDismissed: async ({ locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) return fail(401, { error: "Not authenticated" });

    const { error } = await locals.supabase
      .from("shopping_list_dismissals")
      .delete()
      .eq("user_id", user.id);

    if (error) {
      console.error("[shopping] clearDismissed failed", error);
      return fail(500, { error: error.message });
    }
    return { success: true };
  },
};
