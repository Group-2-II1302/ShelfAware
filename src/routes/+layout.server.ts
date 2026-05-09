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

  let unreadAlertCount = 0;
  if (user) {
    const { count, error } = await locals.supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null)
      .is("read_at", null);

    if (error) {
      console.error("[layout] failed to count unread alerts", error);
    } else {
      unreadAlertCount = count ?? 0;
    }
  }

  return {
    cookies: cookies.getAll(),
    unreadAlertCount,
  };
};
