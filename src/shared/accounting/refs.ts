/**
 * Both keys are HMAC-SHA256 digests of a JSON-encoded tuple, which buys three
 * properties at once:
 *
 * - **Deterministic**, so a retry recomputes the same keys and re-posting is a
 *   no-op.
 * - **Collision-free**, because JSON encoding is injective. A `|`-joined string
 *   would collide `["booking", "a|b"]` with `["booking", "a", "b"]`.
 * - **Non-reversible**, so a provider payment id fed in as a part cannot be
 *   read back out, and the retained ledger holds no provider ids or PII.
 */

import { hmacHash } from "#crypto/hashing.ts";

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
