/**
 * Signed attachment download URLs.
 *
 * Each URL embeds an listing ID, attendee ID, expiry timestamp, and HMAC signature.
 * The server verifies the signature and checks expiry — users must revisit
 * their ticket page to get a fresh URL (prevents sharing).
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { base64ToBase64Url, constantTimeEqual } from "#shared/crypto/utils.ts";
import { ATTACHMENT_URL_MAX_AGE_S } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

/** Build the HMAC message for an attachment download */
const buildMessage = (
  listingId: number,
  attendeeId: number,
  exp: number,
): string => `attachment:${listingId}:${attendeeId}:${exp}`;

/**
 * Generate a signed attachment download URL.
 * Returns the path + query string (e.g., /attachment/42?a=7&exp=1234567890&sig=...).
 */
export const signAttachmentUrl = async (
  listingId: number,
  attendeeId: number,
): Promise<string> => {
  const exp = Math.floor(nowMs() / 1000) + ATTACHMENT_URL_MAX_AGE_S;
  const message = buildMessage(listingId, attendeeId, exp);
  const sig = base64ToBase64Url(await hmacHash(message));
  return `/attachment/${listingId}?a=${attendeeId}&exp=${exp}&sig=${sig}`;
};

/**
 * Verify a signed attachment download URL.
 * Checks HMAC signature and expiry using constant-time comparison.
 */
export const verifyAttachmentUrl = async (
  listingId: number,
  attendeeId: number,
  exp: string,
  sig: string,
): Promise<boolean> => {
  const expNum = Number.parseInt(exp, 10);
  if (Number.isNaN(expNum)) return false;

  const nowS = Math.floor(nowMs() / 1000);
  if (nowS > expNum) return false;
  if (expNum - nowS > ATTACHMENT_URL_MAX_AGE_S + 60) return false;

  const message = buildMessage(listingId, attendeeId, expNum);
  const expectedSig = base64ToBase64Url(await hmacHash(message));
  return constantTimeEqual(expectedSig, sig);
};
