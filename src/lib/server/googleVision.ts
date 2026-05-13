/**
 * googleVision.ts
 *
 * Server-only utility (never imported on the client).
 * Authenticates with Google Cloud using a service account, then calls the
 * Vision API TEXT_DETECTION feature on a base64-encoded image.
 *
 * Uses the Web Crypto API throughout so it is fully compatible with
 * Cloudflare Workers (no Node.js crypto module required).
 */

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function b64url(input: string): string {
  return btoa(input).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlFromBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Parse a PEM private key string from an environment variable.
 * Handles every wire format we've seen in the wild:
 *   - Real newlines (typical when pasted into Cloudflare's dashboard
 *     as a multi-line secret).
 *   - Literal "\n" pairs (typical from a single-line .env value or a
 *     JSON-serialised credentials blob).
 *   - CRLF line endings (Windows clipboards).
 *   - Surrounding double or single quotes (some users paste with the
 *     JSON quotes still attached).
 *   - Unicode "smart quotes" (when the value was copied via a word
 *     processor instead of a plain text editor).
 *   - Stray non-base64 characters anywhere in the body — we filter
 *     down to the base64 alphabet before atob() so a stray char
 *     can't take down the whole decode.
 */
function parsePem(raw: string): ArrayBuffer {
  let cleaned = raw;

  // 1. Strip wrapping quotes if the user pasted them along with the value.
  cleaned = cleaned.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  // 2. Normalise common escape / line-ending variants.
  cleaned = cleaned
    .replace(/\\r\\n/g, "\n") // literal "\r\n" from JSON-encoded values
    .replace(/\\n/g, "\n") // literal "\n"
    .replace(/\r\n/g, "\n") // CRLF -> LF
    .replace(/\r/g, "\n"); // bare CR -> LF

  // 3. Strip the PEM header / footer (case-insensitive, tolerant of
  //    extra whitespace inside the markers themselves).
  cleaned = cleaned
    .replace(/-----\s*BEGIN[^-]*-----/i, "")
    .replace(/-----\s*END[^-]*-----/i, "");

  // 4. Drop everything that isn't part of the base64 alphabet. This is
  //    a belt-and-braces measure — after the steps above the body
  //    should already be clean, but if Cloudflare or a clipboard ever
  //    sneaks in a stray BOM, smart quote, or zero-width space, we
  //    don't want atob() to throw a [502].
  const filtered = cleaned.replace(/[^A-Za-z0-9+/=]/g, "");

  if (!filtered) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY parsed to an empty body. Check the env var contents.",
    );
  }

  try {
    const bytes = Uint8Array.from(atob(filtered), (c) => c.charCodeAt(0));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  } catch (e) {
    /*
      Surface enough structural info for diagnosis without ever
      logging the key itself. Length + a hash of the cleaned body
      tells us whether redeploys actually changed the value, and
      mod-4 tells us if base64 padding is off.
    */
    const len = filtered.length;
    const mod = len % 4;
    throw new Error(
      `GOOGLE_PRIVATE_KEY failed to decode (len=${len}, len%4=${mod}). ` +
        `Original cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Build and sign a Google-compatible JWT using RS256.
 * Returns the signed JWT string ready for token exchange.
 */
async function buildJwt(
  serviceAccountEmail: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: serviceAccountEmail,
      scope: "https://www.googleapis.com/auth/cloud-vision",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const toSign = `${header}.${payload}`;

  const keyData = parsePem(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(toSign),
  );

  return `${toSign}.${b64urlFromBytes(new Uint8Array(sigBytes))}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange a signed JWT for a short-lived OAuth2 Bearer access token.
 * Tokens are valid for 1 hour; for a server that handles many requests you
 * would cache this, but for a mobile scan app the volume is low enough that
 * one token per scan is fine.
 */
async function getAccessToken(
  serviceAccountEmail: string,
  privateKeyPem: string,
): Promise<string> {
  const jwt = await buildJwt(serviceAccountEmail, privateKeyPem);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Vision API call
// ---------------------------------------------------------------------------

/**
 * Send a base64-encoded image to the Cloud Vision TEXT_DETECTION endpoint.
 * Returns the full raw text string that Google detected, or an empty string
 * if nothing was found.
 */
export async function detectText(
  base64Image: string,
  serviceAccountEmail: string,
  privateKeyPem: string,
): Promise<string> {
  const token = await getAccessToken(serviceAccountEmail, privateKeyPem);

  const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64Image },
          features: [{ type: "TEXT_DETECTION", maxResults: 5 }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Vision API error: ${err}`);
  }

  const data = (await res.json()) as {
    responses: Array<{
      fullTextAnnotation?: { text: string };
      textAnnotations?: Array<{ description: string }>;
    }>;
  };

  // fullTextAnnotation gives the cleaner joined string; fall back to the
  // first individual annotation if it's absent.
  return (
    data.responses?.[0]?.fullTextAnnotation?.text ??
    data.responses?.[0]?.textAnnotations?.[0]?.description ??
    ""
  );
}
