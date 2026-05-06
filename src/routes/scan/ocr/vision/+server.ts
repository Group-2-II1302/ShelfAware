import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { detectText } from "$lib/server/googleVision";
import { env } from "$env/dynamic/private";

/**
 * POST /scan/ocr/vision
 *
 * Body: { image: string }  — raw base64 image (no data-URL prefix)
 * Response: { text: string }  — raw text detected by Google Vision
 */
export const POST: RequestHandler = async ({ request }) => {
  let image: string;

  try {
    const body = (await request.json()) as { image?: string };
    image = body.image ?? "";
  } catch {
    throw error(400, "Invalid JSON body");
  }

  if (!image) {
    throw error(400, "Missing image field");
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw error(500, "Google Vision credentials not configured");
  }

  try {
    const text = await detectText(
      image,
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
    );
    console.log("Vision returned:", JSON.stringify(text));
    return json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Vision API error:", msg);
    throw error(502, msg);
  }
};
