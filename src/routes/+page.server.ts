import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, depends }) => {
  /*
    Tag this load so the client can selectively refresh shelf+sync
    state in response to realtime events without invalidating
    everything on the page.
  */
  depends("app:shelves");

  const { data: shelves, error } = await locals.supabase
    .from("shelves")
    .select("id, name")
    .order("name");

  if (error) {
    throw error;
  }

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

  return {
    shelves: shelvesWithSync,
    itemShelfMap,
  };
};
