/**
 * Tamper-evident signature over a checkout's agreed price and the metadata it
 * was agreed under, keyed on the server's encryption key. The provider sees
 * only the digest, so the webhook trusts the total and never derives it again.
 * The proof binds the whole logical metadata, so a field that feeds pricing
 * indirectly, such as a visit-gated modifier's email, cannot change under it.
 *
 * Three keys are excluded: `price_proof`, which cannot sign itself, `b`, the
 * wire-only packed entry, and `_origin`, left unsigned so foreign-session
 * detection can read it and send a tampered session down the no-refund foreign
 * path. `canonicalPricePayload` derives the signed bytes for both sides.
 */

import { constantTimeEqualBytes, hmacHashSync } from "#crypto/hashing.ts";

/** The logical checkout metadata a price signature is computed over — every
 *  field optional, since any may be omitted at signing or "" at verification. */
type SignedMetadata = Partial<Record<string, string>>;

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
  metadata: SignedMetadata,
  total: number,
): string => {
  const entries = Object.entries(metadata)
    .filter(
      (entry): entry is [string, string] =>
        !!entry[1] && !UNSIGNED_KEYS.has(entry[0]),
    )
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return JSON.stringify([PRICE_SIG_VERSION, total, entries]);
};

/** HMAC the canonical payload with the server encryption key. */
export const signPrice = (metadata: SignedMetadata, total: number): string =>
  hmacHashSync(`price-sig:${canonicalPricePayload(metadata, total)}`);

/** Split the `total.sig` price proof into a non-negative integer total and a
 * non-empty signature, or null when the field is absent or malformed. */
export const parsePriceProof = (
  proof: string,
): { total: number; sig: string } | null => {
  const match = /^(\d+)\.(.+)$/.exec(proof);
  return match ? { sig: match[2]!, total: Number(match[1]) } : null;
};

/** Whether `signature` is a valid server signature for `metadata` at `total`.
 * False for any tampered field, a wrong total, or a malformed/empty signature. */
export const verifyPrice = async (
  metadata: SignedMetadata,
  total: number,
  signature: string,
): Promise<boolean> => {
  if (!signature) return false;
  // Compare digest bytes in constant time (lengths, fixed for a digest, may
  // leak). Reuses the crypto module's comparison rather than re-rolling one.
  const expected = new TextEncoder().encode(signPrice(metadata, total));
  const provided = new TextEncoder().encode(signature);
  return (
    expected.length === provided.length &&
    constantTimeEqualBytes(expected, provided)
  );
};
