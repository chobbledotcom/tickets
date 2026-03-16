/**
 * Signed attachment download URLs.
 *
 * Each URL embeds an event ID, attendee ID, expiry timestamp, and HMAC signature.
 * The server verifies the signature and checks expiry — users must revisit
 * their ticket page to get a fresh URL (prevents sharing).
 */

import { base64ToBase64Url, constantTimeEqual, hmacHash } from "#lib/crypto.ts";
import { nowMs } from "#lib/now.ts";

/** How long a signed attachment URL stays valid (1 hour) */
const MAX_AGE_S = 3600;

/** Build the HMAC message for an attachment download */
const buildMessage = (
  eventId: number,
  attendeeId: number,
  exp: number,
): string => `attachment:${eventId}:${attendeeId}:${exp}`;

/**
 * Generate a signed attachment download URL.
 * Returns the path + query string (e.g., /attachment/42?a=7&exp=1234567890&sig=...).
 */
export const signAttachmentUrl = async (
  eventId: number,
  attendeeId: number,
): Promise<string> => {
  const exp = Math.floor(nowMs() / 1000) + MAX_AGE_S;
  const message = buildMessage(eventId, attendeeId, exp);
  const sig = base64ToBase64Url(await hmacHash(message));
  return `/attachment/${eventId}?a=${attendeeId}&exp=${exp}&sig=${sig}`;
};

/**
 * Verify a signed attachment download URL.
 * Checks HMAC signature and expiry using constant-time comparison.
 */
export const verifyAttachmentUrl = async (
  eventId: number,
  attendeeId: number,
  exp: string,
  sig: string,
): Promise<boolean> => {
  const expNum = Number.parseInt(exp, 10);
  if (Number.isNaN(expNum)) return false;

  const nowS = Math.floor(nowMs() / 1000);
  if (nowS > expNum) return false;
  if (expNum - nowS > MAX_AGE_S + 60) return false;

  const message = buildMessage(eventId, attendeeId, expNum);
  const expectedSig = base64ToBase64Url(await hmacHash(message));
  return constantTimeEqual(expectedSig, sig);
};
