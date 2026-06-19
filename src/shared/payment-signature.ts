/**
 * Tamper-evident signature over a checkout's agreed price and the metadata it
 * was agreed under.
 *
 * The public checkout computes the total the buyer agrees to and signs it,
 * bound to the booking fields stored in provider metadata, with an HMAC keyed
 * on the server's encryption key. The payment provider only ever sees the
 * resulting digest, which it cannot forge without the key, so the webhook can
 * trust both the agreed total and the surrounding fields as its oracle instead
 * of re-deriving them and hoping the two computations agree.
 *
 * The signature binds the *whole* logical metadata — every field except the two
 * excluded below — rather than only the obviously price-determining subset. That
 * way a field which feeds pricing indirectly (e.g. email/phone via visit-gated
 * modifiers) or feeds fulfilment (e.g. site_token_index via site renewals)
 * cannot be altered while leaving the proof valid: any change invalidates it and
 * is rejected as tampered metadata rather than quietly re-derived.
 *
 * Two keys are deliberately excluded from the payload:
 *  - `_origin`: left unsigned so the webhook's foreign-session detection can
 *    read its plaintext value. Binding it would push a tampered-origin *ours*
 *    session down the no-refund foreign path and strand a paying customer.
 *  - `price_proof`: the signature itself (it cannot sign itself).
 * `b` (the wire-only packed entry) never reaches this layer — signing and
 * verification both run on the unpacked logical shape — but is excluded
 * defensively in case a caller ever passes raw wire metadata.
 *
 * `canonicalPricePayload` is the single place both sides derive the signed bytes
 * from, so signing (checkout) and verification (webhook) can never drift apart —
 * the failure mode this whole module exists to remove.
 */

import {
  constantTimeEqualBytes,
  hmacHash,
  hmacHashSync,
} from "#shared/crypto/hashing.ts";

/** Bump when the signed-payload layout changes, so old digests never validate
 * against new code. */
const PRICE_SIG_VERSION = "v2";

/** Metadata keys excluded from the signed payload (see module doc). */
const UNSIGNED_KEYS: ReadonlySet<string> = new Set([
  "_origin",
  "price_proof",
  "b",
]);

/**
 * Deterministic canonical string over the agreed total and every signed
 * metadata field.
 *
 * Entries are reduced to the present (truthy) fields and sorted by key, so the
 * bytes are identical whether a field was omitted at signing time (the checkout
 * builds metadata without empty optionals) or normalised to "" at verification
 * time (the webhook's extracted metadata), and regardless of key iteration
 * order. "" is the canonical "absent" everywhere in this codebase, so treating
 * falsy as absent keeps the two sides symmetric.
 */
const canonicalPricePayload = (
  metadata: Partial<Record<string, string>>,
  total: number,
): string => {
  const entries = Object.entries(metadata)
    .filter(
      (entry): entry is [string, string] =>
        !!entry[1] && !UNSIGNED_KEYS.has(entry[0]),
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([PRICE_SIG_VERSION, total, entries]);
};

/** HMAC the canonical payload with the server encryption key. */
export const signPrice = (
  metadata: Partial<Record<string, string>>,
  total: number,
): Promise<string> =>
  hmacHash(`price-sig:${canonicalPricePayload(metadata, total)}`);

/** Synchronous signPrice, for callers (buildItemsMetadata, test factories) that
 * build metadata outside an async context. Produces the identical digest. */
export const signPriceSync = (
  metadata: Partial<Record<string, string>>,
  total: number,
): string =>
  hmacHashSync(`price-sig:${canonicalPricePayload(metadata, total)}`);

/** Whether `signature` is a valid server signature for `metadata` at `total`.
 * False for any tampered field, a wrong total, or a malformed/empty signature. */
export const verifyPrice = async (
  metadata: Partial<Record<string, string>>,
  total: number,
  signature: string,
): Promise<boolean> => {
  if (!signature) return false;
  // Compare digest bytes in constant time (lengths, fixed for a digest, may
  // leak). Reuses the crypto module's comparison rather than re-rolling one.
  const expected = new TextEncoder().encode(await signPrice(metadata, total));
  const provided = new TextEncoder().encode(signature);
  return (
    expected.length === provided.length &&
    constantTimeEqualBytes(expected, provided)
  );
};
