import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

const isLoginPath = (pathname: string) =>
  pathname === "/login" || pathname.startsWith("/login/");

export const load: LayoutServerLoad = async ({ cookies, locals, url }) => {
  const {
    data: { user },
  } = await locals.supabase.auth.getUser();

  if (!user && !isLoginPath(url.pathname)) {
    redirect(303, "/login");
  }

  if (user && isLoginPath(url.pathname)) {
    redirect(303, "/");
  }

  return {
    cookies: cookies.getAll(),
  };
};
