import {
  createBrowserClient,
  createServerClient,
  isBrowser,
} from "@supabase/ssr";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import type { Database } from "$lib/database.types";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ data, depends, fetch }) => {
  // Re-run this load whenever `supabase:auth` is invalidated (e.g. after
  // sign-in / sign-out we call `invalidate('supabase:auth')`).
  depends("supabase:auth");

  const supabase = isBrowser()
    ? createBrowserClient<Database>(
        PUBLIC_SUPABASE_URL,
        PUBLIC_SUPABASE_ANON_KEY,
        {
          global: { fetch },
        },
      )
    : createServerClient<Database>(
        PUBLIC_SUPABASE_URL,
        PUBLIC_SUPABASE_ANON_KEY,
        {
          global: { fetch },
          cookies: {
            getAll: () => data.cookies,
          },
        },
      );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { session, supabase, user };
};
