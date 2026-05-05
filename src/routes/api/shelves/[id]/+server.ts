import type { RequestHandler } from "./types";
import { supabase } from "../../../../lib/supabaseClient";

const BASE_URL = process.env.BACKEND_URL

export const GET: RequestHandler = async ({ params }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(`${BASE_URL}/shelves/${params.id}`, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    if (!res.ok) {
        return new Response(
            JSON.stringify({ error: "Failed to fetch shelf" }),
            { status: res.status }
        );
    }

    const dataRes = await res.json();

    return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
    });
};