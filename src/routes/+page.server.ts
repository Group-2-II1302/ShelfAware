import type { PageServerLoad } from "./$types";

const EXPIRY_WINDOW_DAYS = 7;
const ACTION_LIST_LIMIT = 5;

type ActionItem = {
  id: string;
  shelfId: string;
  shelfName: string;
  scaleIndex: number;
  name: string;
  daysToExpiry: number | null;
  currentWeightG: number | null;
  thresholdG: number | null;
};

export const load: PageServerLoad = async ({ locals, depends }) => {
  /*
    Tag this load so the client can selectively refresh shelf+sync
    state in response to realtime events without invalidating
    everything on the page.
  */
  depends("app:shelves");

  const [{ data: shelves, error }, { data: profile }] = await Promise.all([
    locals.supabase.from("shelves").select("id, name").order("name"),
    locals.supabase
      .from("profiles")
      .select("first_name")
      .eq("id", locals.user?.id ?? "")
      .maybeSingle(),
  ]);

  if (error) {
    throw error;
  }

  const firstName = profile?.first_name?.trim() || null;

  /*
    Compute "last seen" per shelf so the dashboard can render a sync
    badge alongside each name. The naive query is N+1 (one weight_logs
    lookup per shelf), but N is small (a household typically has 1–3
    shelves) and these run in parallel via Promise.all. If shelf
    counts grow we can move this to a Postgres view that pre-computes
    max(recorded_at) per shelf.
  */
  const shelvesWithSync = await Promise.all(
    (shelves ?? []).map(async (shelf) => {
      const { data: items } = await locals.supabase
        .from("shelf_items")
        .select("id")
        .eq("shelf_id", shelf.id);

      const itemIds = (items ?? []).map((it) => it.id);
      let lastSyncedAt: string | null = null;
      if (itemIds.length > 0) {
        const { data: lastLog } = await locals.supabase
          .from("weight_logs")
          .select("recorded_at")
          .in("item_id", itemIds)
          .order("recorded_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        lastSyncedAt = lastLog?.recorded_at ?? null;
      }

      return { ...shelf, lastSyncedAt, hasItems: itemIds.length > 0, itemIds };
    }),
  );

  /*
    Flat item_id → shelf_id index so the client can route incoming
    weight_logs realtime events to the right dashboard row without
    a round-trip. Computed here because the per-shelf itemIds were
    already in scope.
  */
  const itemShelfMap: Record<string, string> = {};
  for (const shelf of shelvesWithSync) {
    for (const id of shelf.itemIds) {
      itemShelfMap[id] = shelf.id;
    }
  }

  /*
    Build the "Now" action lists: items expiring within EXPIRY_WINDOW_DAYS
    (including already-expired) and items currently below their low-stock
    threshold. Joins product_catalog for a readable name; falls back to
    the barcode if no product entry exists yet.
  */
  const shelfNameById: Record<string, string> = {};
  for (const shelf of shelvesWithSync) {
    shelfNameById[shelf.id] = shelf.name;
  }

  const today = new Date(new Date().toISOString().split("T")[0]);
  const todayMs = today.getTime();

  let expiring: ActionItem[] = [];
  let lowStock: ActionItem[] = [];

  const allShelfIds = shelvesWithSync.map((s) => s.id);
  if (allShelfIds.length > 0) {
    const { data: items, error: itemsErr } = await locals.supabase
      .from("shelf_items")
      .select(
        "id, shelf_id, scale_index, barcode, expiry_date, current_weight_g, low_stock_threshold_g, product_catalog(product_name)",
      )
      .in("shelf_id", allShelfIds);

    if (itemsErr) {
      console.error("[dashboard] failed to load action items", itemsErr);
    }

    for (const row of items ?? []) {
      const product = Array.isArray(row.product_catalog)
        ? row.product_catalog[0]
        : row.product_catalog;
      const name =
        (product as { product_name?: string | null } | null)?.product_name ||
        row.barcode ||
        "Item";

      const base: Omit<ActionItem, "daysToExpiry"> = {
        id: row.id,
        shelfId: row.shelf_id,
        shelfName: shelfNameById[row.shelf_id] ?? "Shelf",
        scaleIndex: row.scale_index,
        name,
        currentWeightG: row.current_weight_g,
        thresholdG: row.low_stock_threshold_g,
      };

      if (row.expiry_date) {
        const days = Math.ceil(
          (new Date(row.expiry_date).getTime() - todayMs) / 86_400_000,
        );
        if (days <= EXPIRY_WINDOW_DAYS) {
          expiring.push({ ...base, daysToExpiry: days });
        }
      }

      if (
        row.low_stock_threshold_g !== null &&
        row.current_weight_g !== null &&
        row.current_weight_g <= row.low_stock_threshold_g
      ) {
        lowStock.push({ ...base, daysToExpiry: null });
      }
    }

    /*
      Sort: most urgent first. Expiring uses ascending days (already
      expired = most negative = top). Low stock uses ascending absolute
      weight (emptiest first).
    */
    expiring.sort(
      (a, b) =>
        (a.daysToExpiry ?? Number.POSITIVE_INFINITY) -
        (b.daysToExpiry ?? Number.POSITIVE_INFINITY),
    );
    lowStock.sort(
      (a, b) =>
        (a.currentWeightG ?? Number.POSITIVE_INFINITY) -
        (b.currentWeightG ?? Number.POSITIVE_INFINITY),
    );
  }

  const expiringTotal = expiring.length;
  const lowStockTotal = lowStock.length;

  return {
    shelves: shelvesWithSync,
    itemShelfMap,
    firstName,
    actions: {
      expiring: expiring.slice(0, ACTION_LIST_LIMIT),
      lowStock: lowStock.slice(0, ACTION_LIST_LIMIT),
      expiringTotal,
      lowStockTotal,
      limit: ACTION_LIST_LIMIT,
      /*
        Counts broken down by bucket for the inline summary
        ("3 today, 2 this week" / "running out, low").
      */
      expiringBuckets: {
        expired: expiring.filter((i) => (i.daysToExpiry ?? 0) < 0).length,
        today: expiring.filter((i) => i.daysToExpiry === 0).length,
        soon: expiring.filter((i) => (i.daysToExpiry ?? 0) > 0).length,
      },
    },
  };
};
