import type { RequestHandler } from "./types";

export const GET: RequestHandler = async ({ params, fetch }) => {
  const res = await fetch(`https://supabase.com/shelves/${params.id}`);
  const data = await res.json();

  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
};