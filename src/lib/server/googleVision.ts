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
 * Handles both real newlines and the literal "\n" that .env files produce.
 */
function parsePem(raw: string): Uint8Array {
  const pem = raw
    .replace(/\\n/g, "\n") // literal \n from .env
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, ""); // strip all whitespace / newlines

  return Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
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
    keyData.buffer as ArrayBuffer,
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
