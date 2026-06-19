/**
 * Tamper-evident signature over a checkout's agreed price.
 *
 * The public checkout computes the total the buyer agrees to and signs it,
 * bound to the price/booking fields stored in provider metadata, with an
 * HMAC keyed on the server's encryption key. The payment provider only ever
 * sees the resulting digest, which it cannot forge without the key, so the
 * webhook can trust the agreed total as its pricing oracle instead of
 * re-deriving it and hoping the two computations agree.
 *
 * `priceFieldsFromMetadata` is the single place both sides derive the signed
 * field set from, so signing (checkout) and verification (webhook) can never
 * drift apart — the failure mode this whole module exists to remove.
 */

import { hmacHash, hmacHashSync } from "#shared/crypto/hashing.ts";

/** Bump when the signed-payload layout changes, so old digests never validate
 * against new code. */
const PRICE_SIG_VERSION = "v1";

/** The price- and booking-determining metadata a checkout's signature binds.
 * Held as the verbatim stored strings (not re-parsed values) so the canonical
 * payload is byte-identical on both sides of the provider round-trip. */
export type PriceSignatureFields = {
  /** Agreed order total in minor units. */
  total: number;
  /** metadata.items — compact booking items, each carrying its charged price. */
  items: string;
  /** metadata.modifiers — applied modifier refs ("" when none). */
  modifiers: string;
  /** metadata.answer_ids — per-listing answer ids ("" when none). */
  answerIds: string;
  /** metadata.reservation_amount — deposit snapshot ("" when paid in full). */
  reservationAmount: string;
  /** metadata.balance_attendee_id — set when settling a balance ("" if not). */
  balanceAttendeeId: string;
  /** metadata.day_count — chosen day count for customisable listings ("" if not). */
  dayCount: string;
  /** metadata.date — chosen booking date ("" when not date-bound). */
  date: string;
};

/** Build the signed field set from a metadata record + agreed total. Both the
 * checkout (writing) and the webhook (reading) go through here, so the two can
 * never assemble the payload differently. Absent fields normalize to "". */
export const priceFieldsFromMetadata = (
  metadata: Partial<Record<string, string>>,
  total: number,
): PriceSignatureFields => ({
  answerIds: metadata.answer_ids ?? "",
  balanceAttendeeId: metadata.balance_attendee_id ?? "",
  date: metadata.date ?? "",
  dayCount: metadata.day_count ?? "",
  items: metadata.items ?? "",
  modifiers: metadata.modifiers ?? "",
  reservationAmount: metadata.reservation_amount ?? "",
  total,
});

/** Deterministic canonical string over the signed fields. A fixed-order tuple
 * (not an object) keeps the encoding stable regardless of key iteration. */
const canonicalPricePayload = (fields: PriceSignatureFields): string =>
  JSON.stringify([
    PRICE_SIG_VERSION,
    fields.total,
    fields.items,
    fields.modifiers,
    fields.answerIds,
    fields.reservationAmount,
    fields.balanceAttendeeId,
    fields.dayCount,
    fields.date,
  ]);

/** Constant-time equality for two equal-length digests. Length is allowed to
 * leak (digests are fixed length); content comparison does not short-circuit. */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

/** HMAC the canonical price payload with the server encryption key. */
export const signPrice = (fields: PriceSignatureFields): Promise<string> =>
  hmacHash(`price-sig:${canonicalPricePayload(fields)}`);

/** Synchronous signPrice, for callers (e.g. test factories) that build metadata
 * outside an async context. Produces the identical digest to signPrice. */
export const signPriceSync = (fields: PriceSignatureFields): string =>
  hmacHashSync(`price-sig:${canonicalPricePayload(fields)}`);

/** Whether `signature` is a valid server signature for `fields`. False for any
 * tampered field, a wrong total, or a malformed/empty signature. */
export const verifyPrice = async (
  fields: PriceSignatureFields,
  signature: string,
): Promise<boolean> => {
  if (!signature) return false;
  const expected = await signPrice(fields);
  return constantTimeEqual(expected, signature);
};
