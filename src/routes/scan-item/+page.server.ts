import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { loadShelvesWithSlots } from "$lib/server/loadShelvesWithSlots";

export const load: PageServerLoad = async ({ locals }) => {
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user) throw redirect(303, "/login");

  try {
    return await loadShelvesWithSlots(locals.supabase);
  } catch (e: any) {
    throw error(500, e?.message ?? "Failed to load shelves");
  }
};
