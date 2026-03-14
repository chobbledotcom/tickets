/**
 * Signed CSRF tokens using HMAC.
 *
 * Each token embeds a timestamp, nonce, and HMAC signed with DB_ENCRYPTION_KEY.
 * The server verifies the signature and checks expiry — no cookies needed.
 * This works everywhere including iframes in iOS in-app browsers (Facebook,
 * Instagram) where Safari/WebKit blocks third-party cookies.
 */

import { constantTimeEqual, generateSecureToken, hmacHash } from "#lib/crypto.ts";
import { nowMs } from "#lib/now.ts";

const SIGNED_PREFIX = "s1.";
const DEFAULT_MAX_AGE_S = 3600; // 1 hour

/** Most recently generated CSRF token, readable synchronously by CsrfForm */
const _tokenStore = { value: "" };

/** Default message for invalid/expired CSRF form submissions */
export const CSRF_INVALID_FORM_MESSAGE =
  "Invalid or expired form. Please try again.";

/** Convert standard base64 to base64url (no padding) */
const toBase64Url = (b64: string): string =>
  b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** Build the HMAC message from timestamp and nonce */
const buildMessage = (timestamp: number, nonce: string): string =>
  `${SIGNED_PREFIX}${timestamp}.${nonce}`;

/** Create a signed CSRF token: s1.{timestamp}.{nonce}.{hmac} */
export const signCsrfToken = async (): Promise<string> => {
  const timestamp = Math.floor(nowMs() / 1000);
  const nonce = generateSecureToken();
  const message = buildMessage(timestamp, nonce);
  const hmac = toBase64Url(await hmacHash(message));
  _tokenStore.value = `${message}.${hmac}`;
  return _tokenStore.value;
};

/** Get the most recently generated CSRF token (for synchronous JSX rendering) */
export const getCurrentCsrfToken = (): string => _tokenStore.value;

/** Check whether a token uses the signed format */
export const isSignedCsrfToken = (token: string): boolean =>
  token.startsWith(SIGNED_PREFIX);

/** Verify a signed CSRF token's signature and expiry */
export const verifySignedCsrfToken = async (
  token: string,
  maxAge = DEFAULT_MAX_AGE_S,
): Promise<boolean> => {
  if (!token.startsWith(SIGNED_PREFIX)) return false;

  const withoutPrefix = token.slice(SIGNED_PREFIX.length);
  const parts = withoutPrefix.split(".");
  if (parts.length !== 3) return false;

  const [timestampStr, nonce, providedHmac] = parts;
  const timestamp = Number.parseInt(timestampStr!, 10);
  if (Number.isNaN(timestamp)) return false;

  // Check expiry
  const nowS = Math.floor(nowMs() / 1000);
  if (nowS - timestamp > maxAge) return false;
  // Reject tokens from the future (clock skew tolerance: 60s)
  if (timestamp - nowS > 60) return false;

  // Recompute HMAC and compare
  const message = buildMessage(timestamp, nonce!);
  const expectedHmac = toBase64Url(await hmacHash(message));
  return constantTimeEqual(expectedHmac, providedHmac!);
};
