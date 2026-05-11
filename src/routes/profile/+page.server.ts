import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export type ProfileShelf = {
  id: string;
  name: string;
  last_synced_at: string | null;
};

export const load: PageServerLoad = async ({ locals }) => {
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user) throw redirect(303, "/login");

  const { data: profile, error: profileError } = await locals.supabase
    .from("profiles")
    .select("first_name, last_name, email, phone_number")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw error(500, profileError.message);

  const { data: memberRows, error: shelvesError } = await locals.supabase
    .from("shelf_members")
    .select("shelves ( id, name, last_synced_at )")
    .eq("user_id", user.id);

  if (shelvesError) throw error(500, shelvesError.message);

  const shelves: ProfileShelf[] = [];
  for (const row of memberRows ?? []) {
    const s = row.shelves as ProfileShelf | ProfileShelf[] | null;
    const one = Array.isArray(s) ? s[0] : s;
    if (one?.id) {
      shelves.push({
        id: one.id,
        name: one.name,
        last_synced_at: one.last_synced_at ?? null,
      });
    }
  }

  shelves.sort((a, b) => a.name.localeCompare(b.name));

  return { profile: profile ?? null, shelves };
};

export const actions: Actions = {
  renameShelf: async ({ request, locals }) => {
    const {
      data: { user },
    } = await locals.supabase.auth.getUser();
    if (!user) {
      return fail(401, { renameError: "Not signed in.", renameShelfId: null });
    }

    const formData = await request.formData();
    const shelfId = formData.get("shelf_id")?.toString();
    const nameRaw = formData.get("name")?.toString() ?? "";

    if (!shelfId) {
      return fail(400, {
        renameError: "Missing shelf.",
        renameShelfId: null,
      });
    }

    const name = nameRaw.trim();
    if (!name) {
      return fail(400, {
        renameError: "Name cannot be empty.",
        renameShelfId: shelfId,
      });
    }
    if (name.length > 200) {
      return fail(400, {
        renameError: "Name is too long (max 200 characters).",
        renameShelfId: shelfId,
      });
    }

    const { data: membership, error: memberErr } = await locals.supabase
      .from("shelf_members")
      .select("id")
      .eq("user_id", user.id)
      .eq("shelf_id", shelfId)
      .maybeSingle();

    if (memberErr) {
      return fail(500, {
        renameError: memberErr.message,
        renameShelfId: shelfId,
      });
    }
    if (!membership) {
      return fail(403, {
        renameError: "You cannot rename this shelf.",
        renameShelfId: shelfId,
      });
    }

    const { error: updateErr } = await locals.supabase
      .from("shelves")
      .update({ name })
      .eq("id", shelfId);

    if (updateErr) {
      return fail(500, {
        renameError: updateErr.message,
        renameShelfId: shelfId,
      });
    }

    return { renameSuccess: true as const, renameShelfId: shelfId };
  },
};
