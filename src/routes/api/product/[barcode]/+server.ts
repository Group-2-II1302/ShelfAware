import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * Server-side proxy for the OpenFoodFacts product API.
 *
 * Why this exists:
 * 1. OpenFoodFacts asks all API consumers to send a custom User-Agent
 *    of the form "AppName/Version (ContactEmail)" to avoid being treated
 *    as bots. Browsers don't allow overriding User-Agent in fetch(), so
 *    we have to make the call from the server.
 * 2. Centralizing the call gives us a single place to add caching, retry
 *    logic, or rate-limit handling later if it becomes a hot path.
 *
 * https://openfoodfacts.github.io/openfoodfacts-server/api/
 */

const OFF_USER_AGENT = "ShelfAware/0.1 (group2.ii1302@example.com)";

export const GET: RequestHandler = async ({ params, fetch }) => {
  const barcode = params.barcode?.trim();

  if (!barcode || !/^\d{6,}$/.test(barcode)) {
    throw error(400, "Invalid barcode");
  }

  let res: Response;
  try {
    res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
      {
        headers: {
          "User-Agent": OFF_USER_AGENT,
          Accept: "application/json",
        },
      },
    );
  } catch (err) {
    console.error("OpenFoodFacts upstream fetch failed:", err);
    throw error(502, "Could not reach OpenFoodFacts");
  }

  if (!res.ok) {
    /*
      OFF returns 404 when a barcode is unknown — surface that as a
      well-formed body the client can branch on rather than an HTTP
      error, since "not found" is a normal flow (we fall through to
      manual entry).
    */
    if (res.status === 404) {
      return json({ status: 0, code: barcode });
    }
    throw error(res.status, `OpenFoodFacts returned ${res.status}`);
  }

  const data = await res.json();
  return json(data);
};
