import type { RequestHandler } from "./types";

const BASE_URL = process.env.BACKEND_URL

export const GET: RequestHandler = async ({ params, locals }) => {
    const session = locals.getSession();
    const token = session?.access_token;

    if (!token) {
        return new Response(
            JSON.stringify({ error: "Unauthorized" }),
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

    if (res.status === 404) {
        return new Response(
            JSON.stringify({ error: "Shelf_not_found" }),
            { status: 404 }
        );
    }

  if (res.status === 401) {
        return new Response(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401 }
        );
    }

    if (!res.ok) {
        return new Response(
            JSON.stringify({
                error: body?.error || "Failed to fetch shelf"
            }),
            { status: res.status }
        );
    }

    return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" }
    });
};