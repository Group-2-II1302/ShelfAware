import { supabase } from "./supabaseClient";
import { BACKEND_URL } from "./config";

/*
  Always re-read the session before a request. supabase-js holds the
  freshest token (it transparently refreshes on the side), so calling
  getSession() per request is essentially free and avoids the stale
  cached-token failure mode.
*/
async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? null;

  if (!token) {
    throw new Error("AUTH_NOT_READY");
  }

  return token;
}

async function authFetch(input: string, init: RequestInit = {}) {
  const token = await getToken();

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, {
    ...init,
    headers,
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
  const res = await authFetch(`${BACKEND_URL}/shelves`);

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
  const res = await authFetch(`${BACKEND_URL}/shelves/${shelfId}`);

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
