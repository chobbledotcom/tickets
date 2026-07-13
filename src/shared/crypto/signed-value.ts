/**
 * Verify a value signed with an embedded expiry timestamp.
 *
 * Signed attachment URLs and signed CSRF tokens share the same shape: an
 * integer seconds field, a validity window around "now", and an HMAC over a
 * message the caller rebuilds. This captures that whole tail once; each caller
 * supplies only what differs — its window and how it builds the message.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { base64ToBase64Url, constantTimeEqual } from "#shared/crypto/utils.ts";
import { nowSeconds } from "#shared/now.ts";

export const verifySignedValue = async (
  timeField: string,
  providedSig: string,
  withinWindow: (value: number, nowS: number) => boolean,
  buildMessage: (value: number) => string,
): Promise<boolean> => {
  const value = Number.parseInt(timeField, 10);
  if (Number.isNaN(value)) return false;
  if (!withinWindow(value, nowSeconds())) return false;
  const expected = base64ToBase64Url(await hmacHash(buildMessage(value)));
  return constantTimeEqual(expected, providedSig);
};
