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

  if (isBrowser()) {
    // In the browser we re-validate the session ourselves: getSession()
    // reads the local cookie (cheap), getUser() hits the auth server to
    // verify the JWT (one round-trip). This keeps client-side auth state
    // fresh after sign-in / sign-out without trusting stale SSR data.
    const supabase = createBrowserClient<Database>(
      PUBLIC_SUPABASE_URL,
      PUBLIC_SUPABASE_ANON_KEY,
      {
        global: { fetch },
      },
    );

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    return { session, supabase, user };
  }

  // On the server we trust the session + user passed from +layout.server.ts,
  // which originated from `locals.safeGetSession()` in hooks.server.ts and
  // has already been verified against Supabase. Skipping the extra getUser()
  // here avoids a redundant auth round-trip during SSR.
  const supabase = createServerClient<Database>(
    PUBLIC_SUPABASE_URL,
    PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { fetch },
      cookies: {
        getAll: () => data.cookies,
      },
    },
  );

  return { session: data.session, supabase, user: data.user };
};
