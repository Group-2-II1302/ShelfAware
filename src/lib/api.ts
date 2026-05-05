import { supabase } from "./supabaseClient";

async function authFetch(input: string, init: RequestInit = {}) {
    const {
        data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
        throw new Error("NOT_AUTHENTICATED");
    }

    const res = await fetch(input, {
        ...init,
        headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${session.access_token}`
        }
    });

    return res;
}

export type ShelfSummary = {
    shelf_id: string;
    name: string;
    created_at: string;
};

export type ShelfDetail = {
    shelf_id: string;
    items: Array<{
        scale_index: number;
        current_weight_g: number;
    }>;
};

export async function getShelves(): Promise<ShelfSummary[]> {
    const res = await authFetch("/api/shelves");

    if (res.status === 401) throw new Error("UNAUTHORIZED");

    if (!res.ok) throw new Error("SHELVES_FETCH_FAILED");

    const data = await res.json();

    return data.shelves;
}

export async function getShelf(shelfId: string): Promise<ShelfDetail> {
    const res = await fetch(`/api/shelves/`);

    if (res.status === 404) throw new Error("Shelf not found");

    if (res.status === 401) throw new Error("Unauthorized");
    
    if (!res.ok) throw new Error("Shelf fetch failed");
    
    return res.json()
}