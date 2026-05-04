import { supabase } from "$lib/supabaseClient";

export const load = async () => {
  const { data: items, error: itemsError } = await supabase
    .from("shelf_items")
    .select("id, expiry_date, barcode");
  
  console.log("--- Supabase Debug ---");
  console.log("Raw Items from DB:", items);
  if (itemsError) console.error("Error fetching items:", itemsError.message);

  const today = new Date().toISOString().split('T')[0];

  const { data: sentToday } = await supabase.from("alerts")
    .select("item_id")
    .gte("last_triggered_at", today);
    
  console.log("Alert IDs already sent today:", sentToday?.map(s => s.item_id));

  const toInsert = (items ?? [])
    .filter(item => {
      if (!item.expiry_date) return false;
      
      const diff = new Date(item.expiry_date).getTime() - new Date().getTime();
      const days = Math.floor(diff / 86400000);
      const alreadySent = sentToday?.some(s => s.item_id === item.id);
      
      const shouldTrigger = days <= 2 && !alreadySent;
      
      if (shouldTrigger) {
        console.log(`Triggering alert for ${item.barcode}: ${days} days remaining.`);
      }
      
      return shouldTrigger;
    })
    .map(item => ({
      item_id: item.id,
      alert_type: "EXPIRY",
      last_triggered_at: new Date().toISOString()
    }));

  if (toInsert.length > 0) {
    console.log("Inserting new alerts:", toInsert);
    const { error: insError } = await supabase.from("alerts").insert(toInsert);
    if (insError) console.error("Insert failed:", insError.message);
  } else {
    console.log("No new alerts to insert.");
  }

  // 4. Final fetch for the UI
  const { data: alerts, error: alertsError } = await supabase
    .from("alerts")
    .select("*, shelf_items(barcode, expiry_date)")
    .order("last_triggered_at", { ascending: false });

  if (alertsError) console.error("Fetch alerts error:", alertsError.message);
  console.log("Final notifications sent to UI:", alerts);
  console.log("----------------------");

  return { notifications: alerts ?? [] };
};