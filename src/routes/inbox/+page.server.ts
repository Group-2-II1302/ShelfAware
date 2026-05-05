import { supabase } from "$lib/supabaseClient";

export async function load() {
  const now = new Date();
  const todayISO = now.toISOString().split("T")[0];
  const startOfToday = new Date(todayISO).getTime();

  const [itemsRes, sentTodayRes] = await Promise.all([
    supabase
      .from("shelf_items")
      .select(
        "id, expiry_date, barcode, current_weight_g, low_stock_threshold_g",
      ),
    supabase
      .from("alerts")
      .select("item_id, alert_type")
      .gte("last_triggered_at", todayISO),
  ]);

  const sentToday = new Set(
    (sentTodayRes.data ?? []).map(function (s) {
      return s.item_id + "-" + s.alert_type;
    }),
  );

  const toInsert: {
    item_id: string;
    alert_type: string;
    last_triggered_at: string;
  }[] = [];
  (itemsRes.data ?? []).forEach(function (item) {
    if (item.expiry_date) {
      const diff = Math.ceil(
        (new Date(item.expiry_date).getTime() - startOfToday) / 86400000,
      );
      if (diff <= 2 && !sentToday.has(item.id + "-EXPIRY")) {
        toInsert.push({
          item_id: item.id,
          alert_type: "EXPIRY",
          last_triggered_at: now.toISOString(),
        });
      }
    }

    if (
      item.current_weight_g <= item.low_stock_threshold_g &&
      !sentToday.has(item.id + "-LOWSTOCK")
    ) {
      toInsert.push({
        item_id: item.id,
        alert_type: "LOWSTOCK",
        last_triggered_at: now.toISOString(),
      });
    }
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
      return {
        id: n.id,
        message: formatMessage(n, startOfToday),
        timestamp: formatRelative(n.last_triggered_at),
      };
    }),
  };
}

function formatMessage(n: any, startOfToday: number) {
  const shelf = n.shelf_items;
  if (!shelf) return n.alert_type;

  const name = shelf.product_catalog?.product_name || shelf.barcode;

  if (n.alert_type === "LOWSTOCK") {
    return name + " is running low";
  }

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
