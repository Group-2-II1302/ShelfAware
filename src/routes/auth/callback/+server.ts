import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (code) {
    const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return new Response(null, {
        status: 303,
        headers: { location: next },
      });
    }
  }

  return new Response(null, {
    status: 303,
    headers: { location: "/login?error=oauth" },
  });
};
