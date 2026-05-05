import type { RequestHandler } from "./types";
import { supabase } from "../../../../lib/supabaseClient";

const BASE_URL = process.env.BACKEND_URL

export const GET: RequestHandler = async ({ params }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

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

    const body = await res.json().catch(() => null);

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