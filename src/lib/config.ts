import { env } from "$env/dynamic/public";

/*
  Backend (Cloudflare Worker) base URL. Read from PUBLIC_BACKEND_URL
  so dev / staging / prod can differ without code changes. Required —
  no fallback, so a missing env var fails loudly at first use rather
  than silently routing traffic to a hardcoded host.
*/
export const BACKEND_URL: string = (() => {
  const url = env.PUBLIC_BACKEND_URL?.trim();
  if (!url) {
    throw new Error(
      "PUBLIC_BACKEND_URL is not set. Add it to your .env (see .env.example).",
    );
  }
  return url;
})();
