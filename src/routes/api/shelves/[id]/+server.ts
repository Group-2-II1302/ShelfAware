import type { RequestHandler } from "./types";

const BASE_URL = "https://shelfaware-backend.emanuel-diktonius.workers.dev";

export const GET: RequestHandler = async ({ params, locals }) => {

    const session = locals.getSession();
    const token = session?.access_token;

    if (!token) {
        return new Response(
            JSON.stringify({ error: "unauthorized" }),
            { status: 401 }
        );
    }

    const res = await fetch(`${BASE_URL}/shelves/${params.id}`, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    let body: any = null;

    try {
        body = await res.json();
    } catch {
        body = null;
    }

    // Normalize 404 (hidden existence vs permission)
    if (res.status === 404) {
        return new Response(
            JSON.stringify({ error: "not_found" }),
            { status: 404 }
        );
    }

    if (res.status === 401) {
        return new Response(
            JSON.stringify({ error: "unauthorized" }),
            { status: 401 }
        );
    }

    if (!res.ok) {
        return new Response(
            JSON.stringify({
                error: body?.error ?? "failed_to_fetch_shelf"
            }),
            { status: res.status }
        );
    }

    return new Response(JSON.stringify(body), {
        headers: {
            "Content-Type": "application/json",

            // 🔥 optional but useful during setup polling
            "Cache-Control": "no-store"
        }
    });
};