import { supabase } from "$lib/supabaseClient";

export async function load() {
  const now = new Date();
  const todayISO = now.toISOString().split("T")[0];
  const startOfToday = new Date(todayISO).getTime();
  const [itemsRes, sentTodayRes] = await Promise.all([
    supabase.from("shelf_items").select("id, expiry_date, barcode"),
    supabase
      .from("alerts")
      .select("item_id")
      .gte("last_triggered_at", todayISO),
  ]);

  const sentIds = new Set((sentTodayRes.data ?? []).map((s) => s.item_id));

  const toInsert = (itemsRes.data ?? [])
    .filter(function (item) {
      if (!item.expiry_date) return false;
      const diff = Math.ceil(
        (new Date(item.expiry_date).getTime() - startOfToday) / 86400000,
      );
      return diff <= 2 && !sentIds.has(item.id);
    })
    .map(function (item) {
      return {
        item_id: item.id,
        alert_type: "EXPIRY",
        last_triggered_at: now.toISOString(),
      };
    });

  if (toInsert.length > 0) await supabase.from("alerts").insert(toInsert);

  const { data: alerts } = await supabase
    .from("alerts")
    .select(
      "*, shelf_items(barcode, expiry_date, product_catalog(product_name))",
    )
    .order("last_triggered_at", { ascending: false });

  return {
    notifications: (alerts ?? []).map(function (n: any) {
      const shelf = n.shelf_items;
      let msg = n.alert_type;

      if (shelf) {
        const diff = Math.ceil(
          (new Date(shelf.expiry_date).getTime() - startOfToday) / 86400000,
        );
        const status =
          diff < 0
            ? "expired"
            : diff === 0
              ? "expires today"
              : "expires in " + diff + " day(s)";
        msg =
          (shelf.product_catalog?.product_name || shelf.barcode) + " " + status;
      }

      return {
        id: n.id,
        message: msg,
        timestamp: formatRelative(n.last_triggered_at),
      };
    }),
  };
}

function formatRelative(dateStr: string) {
  if (!dateStr) return "Unknown date";
  const delta = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (delta < 60) return "just now";
  const mins = Math.floor(delta / 60);
  if (mins < 60) return mins + " minutes ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " hours ago";
  return new Date(dateStr).toLocaleDateString();
}
