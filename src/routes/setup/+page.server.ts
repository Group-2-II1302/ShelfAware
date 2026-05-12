import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user) {
    throw error(401, "Not signed in");
  }

  return {
    userId: user.id,
  };
};
