import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const startedAt = Date.now();

  const { count, error } = await locals.supabase
    .from("shelves")
    .select("*", { count: "exact", head: true });

  const elapsedMs = Date.now() - startedAt;

  if (error) {
    return {
      ok: false as const,
      elapsedMs,
      error: {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      },
    };
  }

  return {
    ok: true as const,
    elapsedMs,
    count: count ?? 0,
  };
};
