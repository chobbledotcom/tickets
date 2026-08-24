/**
 * Signed attachment download URLs.
 *
 * Each URL embeds an listing ID, attendee ID, expiry timestamp, and HMAC signature.
 * The server verifies the signature and checks expiry — users must revisit
 * their ticket page to get a fresh URL (prevents sharing).
 */

import { hmacHash } from "#crypto/hashing.ts";
import { verifySignedValue } from "#crypto/signed-value.ts";
import { base64ToBase64Url } from "#crypto/utils.ts";
import { ATTACHMENT_URL_MAX_AGE_S } from "#shared/limits.ts";
import { nowSeconds } from "#shared/now.ts";

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
  const exp = nowSeconds() + ATTACHMENT_URL_MAX_AGE_S;
  const message = buildMessage(listingId, attendeeId, exp);
  const sig = base64ToBase64Url(await hmacHash(message));
  return `/attachment/${listingId}?a=${attendeeId}&exp=${exp}&sig=${sig}`;
};

/**
 * Verify a signed attachment download URL.
 * Checks HMAC signature and expiry using constant-time comparison.
 */
export const verifyAttachmentUrl = (
  listingId: number,
  attendeeId: number,
  exp: string,
  sig: string,
): Promise<boolean> =>
  verifySignedValue(
    exp,
    sig,
    // Valid from now until the signed expiry (with 60s of clock-skew slack).
    (expNum, nowS) =>
      nowS <= expNum && expNum - nowS <= ATTACHMENT_URL_MAX_AGE_S + 60,
    (expNum) => buildMessage(listingId, attendeeId, expNum),
  );
