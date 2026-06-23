/**
 * Opaque, non-reversible references for the ledger.
 *
 * Every leg of one business event shares an `eventGroup`; each leg also gets its
 * own `legReference`, which is the per-leg idempotency key. Both are HMAC-SHA256
 * digests of a JSON-encoded tuple, which gives three properties at once:
 *
 * - **Deterministic** — a retry of the same event recomputes the same keys, so
 *   re-posting is a no-op (the store dedupes on `legReference`).
 * - **Collision-free** — JSON encoding is injective, so `["booking", "a|b"]` and
 *   `["booking", "a", "b"]` produce different digests (a `|`-joined string would
 *   not).
 * - **Non-reversible** — a provider payment id fed in as a part cannot be read
 *   back out of the digest, so the retained ledger holds no provider ids or PII.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";

/** A component of a reference tuple. Numbers are JSON-encoded as-is. */
export type RefPart = string | number;

const digest = (domain: string, parts: RefPart[]): Promise<string> => {
  // A numeric part must be a safe integer. JSON.stringify serialises NaN/Infinity
  // as `null` (distinct non-finite ids would collide on one key) and silently
  // rounds integers past Number.MAX_SAFE_INTEGER (9007199254740993 → ...992, so
  // two distinct ids would hash alike). Either way unrelated transfers would
  // share a reference and be wrongly deduped or flagged as conflicts, so reject
  // rather than hash an ambiguous input — row ids are always safe integers.
  for (const part of parts) {
    if (typeof part === "number" && !Number.isSafeInteger(part)) {
      throw new Error(`reference part is not a safe integer: ${part}`);
    }
  }
  return hmacHash(`${domain}:${JSON.stringify(parts)}`);
};

/** The shared id for every leg of one business event (booking/refund/…). */
export const eventGroup = (parts: RefPart[]): Promise<string> =>
  digest("eg", parts);

/** The per-leg idempotency key. The `domain` prefix keeps it distinct from an
 *  event group built from the same parts. */
export const legReference = (parts: RefPart[]): Promise<string> =>
  digest("ref", parts);
