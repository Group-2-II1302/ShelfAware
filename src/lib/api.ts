import { supabase } from "./supabaseClient";

const WORKER_URL = "https://shelfaware-backend.emanuel-diktonius.workers.dev";

let cachedToken: string | null = null;

async function getToken(): Promise<string> {
    if (cachedToken) return cachedToken;

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? null;

    if (!token) {
        throw new Error("AUTH_NOT_READY");
    }

    cachedToken = token;
    return token;
}

async function authFetch(input: string, init: RequestInit = {}) {
    const token = await getToken();

    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    return fetch(input, {
        ...init,
        headers
    });
}

// -----------------------------
// Types
// -----------------------------

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

// -----------------------------
// API
// -----------------------------

export async function getShelves(): Promise<ShelfSummary[]> {
    const res = await authFetch(`${WORKER_URL}/shelves`);

    if (res.status === 401) {
        throw new Error("UNAUTHORIZED");
    }

    if (!res.ok) {
        throw new Error("SHELVES_FETCH_FAILED");
    }

    const data = await res.json();

    return data.shelves;
}

export async function getShelf(shelfId: string): Promise<ShelfDetail> {
    const res = await authFetch(`${WORKER_URL}/shelves/${shelfId}`);

    if (res.status === 404) {
        throw new Error("SHELF_NOT_FOUND");
    }

    if (res.status === 401) {
        throw new Error("UNAUTHORIZED");
    }

    if (!res.ok) {
        throw new Error("SHELF_FETCH_FAILED");
    }

    return res.json();
}