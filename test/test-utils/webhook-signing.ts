/**
 * HMAC-SHA256 signing helpers shared by the Stripe and Square webhook tests.
 * Both providers sign their webhook payloads with an HMAC key; Stripe reads the
 * digest as lowercase hex (`v1=<hex>`) and Square reads it as base64, so the
 * shared `hmacSign` does the signing and the two thin wrappers format it.
 */

/** Sign the bytes with the secret and return the raw HMAC-SHA256 digest. */
export const hmacSign = async (
  secret: string,
  message: Uint8Array,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
};

/** Sign a text message and return the lowercase hex digest (Stripe's `v1=`). */
export const hmacHex = async (
  secret: string,
  message: string,
): Promise<string> => {
  const digest = await hmacSign(secret, new TextEncoder().encode(message));
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** Sign already-encoded bytes and return the base64 digest (Square's form). */
export const hmacBase64 = async (
  secret: string,
  message: Uint8Array,
): Promise<string> =>
  btoa(String.fromCharCode(...(await hmacSign(secret, message))));
