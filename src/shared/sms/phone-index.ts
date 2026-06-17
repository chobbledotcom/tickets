/**
 * Blind-index for matching inbound SMS replies to an attendee.
 *
 * Phones are stored encrypted with no lookup index, so when an admin first
 * texts an attendee we compute an HMAC of their number and store it on the
 * attendee row. An inbound reply's sender is hashed the same way to find the
 * attendee. Normalisation keeps only the last 9 digits (the national
 * significant number) so "+447700900123" and "07700 900123" match.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";

/** Reduce a phone number to a stable form: digits only, last 9. */
export const normalizeForIndex = (phone: string): string =>
  phone.replace(/\D/g, "").slice(-9);

/** HMAC blind-index of a phone number (empty in → empty out). */
export const computePhoneIndex = (phone: string): Promise<string> => {
  const normalized = normalizeForIndex(phone);
  return normalized === "" ? Promise.resolve("") : hmacHash(normalized);
};
