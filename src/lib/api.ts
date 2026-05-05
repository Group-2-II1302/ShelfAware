import { supabase } from "./supabaseClient";

export async function getShelf(shelfId: string) {
    const {
        data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) throw new Error("Not authenticated");
    
    const res = await fetch(`/api/shelves/${shelfId}`, {
        headers: {
            Authorization: `Bearer ${session.access_token}`
        }
    });

    if (res.status === 404) throw new Error("Shelf not found");

    if (res.status === 401) throw new Error("Unauthorized");
    
    if (!res.ok) throw new Error("Shelf fetch failed");
    
    return res.json() as Promise<{
    shelf_id: string;
    items: Array<{
      scale_index: number;
      current_weight_g: number;
    }>;
  }>;
}