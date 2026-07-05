/**
 * Signed CSRF tokens using HMAC.
 *
 * Each token embeds a timestamp, nonce, and HMAC signed with DB_ENCRYPTION_KEY.
 * The server verifies the signature and checks expiry — no cookies needed.
 * This works everywhere including iframes in iOS in-app browsers (Facebook,
 * Instagram) where Safari/WebKit blocks third-party cookies.
 */

import { t } from "#i18n";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  base64ToBase64Url,
  constantTimeEqual,
  generateSecureToken,
} from "#shared/crypto/utils.ts";
import { nowMs } from "#shared/now.ts";
import { createRequestScoped } from "#shared/request-scoped.ts";

const SIGNED_PREFIX = "s1.";
const DEFAULT_MAX_AGE_S = 3600; // 1 hour

/** Most recently generated CSRF token, readable synchronously by CsrfForm */
const tokenScope = createRequestScoped<{ value: string }>(() => ({
  value: "",
}));

/** Run a function within a CSRF-token scope (one container per request) */
export const runWithCsrfContext = <T>(fn: () => T): T => tokenScope.run(fn);

/** Default message for invalid/expired CSRF form submissions (request-scoped). */
export const csrfInvalidFormMessage = (): string => t("error.csrf_invalid");

/** Build the HMAC message from timestamp and nonce */
const buildMessage = (timestamp: number, nonce: string): string =>
  `${SIGNED_PREFIX}${timestamp}.${nonce}`;

/** Create a signed CSRF token: s1.{timestamp}.{nonce}.{hmac} */
export const signCsrfToken = async (): Promise<string> => {
  const timestamp = Math.floor(nowMs() / 1000);
  const nonce = generateSecureToken();
  const message = buildMessage(timestamp, nonce);
  const hmac = base64ToBase64Url(await hmacHash(message));
  const token = `${message}.${hmac}`;
  tokenScope.current().value = token;
  return token;
};

/** Get the most recently generated CSRF token (for synchronous JSX rendering) */
export const getCurrentCsrfToken = (): string => tokenScope.current().value;

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

  const timestampStr = parts[0];
  const nonce = parts[1];
  const providedHmac = parts[2];
  if (!timestampStr || !nonce || !providedHmac) return false;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) return false;

  // Check expiry
  const nowS = Math.floor(nowMs() / 1000);
  if (nowS - timestamp > maxAge) return false;
  // Reject tokens from the future (clock skew tolerance: 60s)
  if (timestamp - nowS > 60) return false;

  // Recompute HMAC and compare
  const message = buildMessage(timestamp, nonce);
  const expectedHmac = base64ToBase64Url(await hmacHash(message));
  return constantTimeEqual(expectedHmac, providedHmac);
};
