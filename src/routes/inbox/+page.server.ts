import { fail, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

type AlertRow = {
  id: string;
  alert_type: string;
  last_triggered_at: string | null;
  read_at: string | null;
  shelf_items:
    | {
        barcode: string | null;
        expiry_date: string | null;
        product_catalog:
          | { product_name: string | null }
          | { product_name: string | null }[]
          | null;
      }
    | {
        barcode: string | null;
        expiry_date: string | null;
        product_catalog:
          | { product_name: string | null }
          | { product_name: string | null }[]
          | null;
      }[]
    | null;
};

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends("app:alerts");

  const startOfToday = new Date(
    new Date().toISOString().split("T")[0],
  ).getTime();

  const { data, error } = await locals.supabase
    .from("alerts")
    .select(
      "id, alert_type, last_triggered_at, read_at, shelf_items(barcode, expiry_date, product_catalog(product_name))",
    )
    .is("resolved_at", null)
    .order("last_triggered_at", { ascending: false });

  if (error) {
    console.error("[inbox] failed to load alerts", error);
  }

  const rows = (data ?? []) as unknown as AlertRow[];

  return {
    notifications: rows.map((n) => {
      const shelf = firstOrNull(n.shelf_items);
      const daysToExpiry = shelf?.expiry_date
        ? Math.ceil(
            (new Date(shelf.expiry_date).getTime() - startOfToday) / 86_400_000,
          )
        : null;
      return {
        id: n.id,
        alertType: n.alert_type,
        lastTriggeredAt: n.last_triggered_at,
        readAt: n.read_at,
        message: formatMessage(n, startOfToday),
        /*
          `daysToExpiry` powers the client-side urgency classifier
          (red for expired, amber for ≤2 days, etc.). For low-stock
          alerts this is irrelevant and may be null — the classifier
          handles that case explicitly.
        */
        daysToExpiry,
      };
    }),
  };
};

export const actions: Actions = {
  markRead: async ({ request, locals }) => {
    const form = await request.formData();
    const id = form.get("id");
    if (typeof id !== "string" || !id) {
      return fail(400, { message: "Missing alert id" });
    }

    const { error } = await locals.supabase
      .from("alerts")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .is("read_at", null);

    if (error) {
      console.error("[inbox] failed to mark alert read", error);
      return fail(500, { message: "Could not mark notification as read" });
    }

    return { success: true };
  },

  markAllRead: async ({ locals }) => {
    const { error } = await locals.supabase
      .from("alerts")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null)
      .is("resolved_at", null);

    if (error) {
      console.error("[inbox] failed to mark all alerts read", error);
      return fail(500, { message: "Could not mark notifications as read" });
    }

    return { success: true };
  },
};

function firstOrNull<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function formatMessage(n: AlertRow, startOfToday: number) {
  const shelf = firstOrNull(n.shelf_items);
  if (!shelf) return n.alert_type;

  const product = firstOrNull(shelf.product_catalog);
  const name = product?.product_name || shelf.barcode || "Item";

  if (n.alert_type === "LOWSTOCK") {
    return name + " is running low";
  }

  if (!shelf.expiry_date) return name;

  const diff = Math.ceil(
    (new Date(shelf.expiry_date).getTime() - startOfToday) / 86400000,
  );
  const status =
    diff < 0
      ? "expired"
      : diff === 0
        ? "expires today"
        : "expires in " + diff + " day(s)";
  return name + " " + status;
}
