/**
 * Conflict detection for ledger writes.
 *
 * Two kinds of guard live here, both raising {@link LedgerConflictError}:
 * - replay equality — a re-post of an already-stored event must present the exact
 *   same legs, so a mapper or pricing change can't quietly rewrite a charge;
 * - reversal links — a leg that says it reverses another must really be that
 *   original's inverse, so the one-void-per-original slot is never wasted.
 */

import { type RowReader, selectById } from "#shared/accounting/rows.ts";
import { legIdentityDiff } from "#shared/ledger/reconcile.ts";
import { isInverseOf } from "#shared/ledger/reverse.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";

/** Raised when a replayed event differs from what is already stored — a leg
 *  with different money facts, an extra leg, or a missing leg — or when a
 *  reversal link doesn't match its original. Surfaced loudly. */
export class LedgerConflictError extends Error {
  constructor(reference: string, detail: string) {
    super(`ledger conflict on reference "${reference}": ${detail}`);
    this.name = "LedgerConflictError";
  }
}

/**
 * Check that a replayed event presents exactly the stored leg set. Throws if the
 * replay omits a stored leg, adds a leg that was never stored, or changes a
 * leg's money facts. The per-leg comparison is {@link legIdentityDiff}, the same
 * money-identity test reconciliation fingerprints use, so `memo` (non-deterministic
 * ciphertext) and the write-time `recorded_at`/`posted_by` metadata are ignored.
 */
export const assertEventMatches = (
  eventGroup: string,
  stored: Transfer[],
  inputs: TransferInput[],
): void => {
  const storedByRef = new Map(stored.map((t) => [t.reference, t]));
  const inputRefs = new Set(inputs.map((t) => t.reference));
  for (const leg of stored) {
    if (!inputRefs.has(leg.reference)) {
      throw new LedgerConflictError(
        leg.reference,
        `event "${eventGroup}" is already posted with a leg this replay omits`,
      );
    }
  }
  for (const input of inputs) {
    const prior = storedByRef.get(input.reference);
    if (!prior) {
      throw new LedgerConflictError(
        input.reference,
        `event "${eventGroup}" is already posted without this leg`,
      );
    }
    const mismatches = legIdentityDiff(prior, input);
    if (mismatches.length > 0) {
      throw new LedgerConflictError(
        input.reference,
        `stored leg differs in ${mismatches.join(", ")}`,
      );
    }
  }
};

/**
 * The pure half of {@link assertReverses}: check a leg against the already-fetched
 * `original` it claims to reverse. A leg that links to another via `reversesId`
 * must be that original's exact inverse and the original must exist; otherwise the
 * unique `reverses_id` slot is used up without the original money actually being
 * voided, or it points at nothing — either way permanently blocking the correct
 * reversal. Pass the original you loaded (or `null` if none); a leg with no
 * `reversesId` passes trivially. The batch writer uses this against originals it
 * pre-loaded in bulk, so it needs no per-leg read inside its write.
 */
export const assertReversesAgainst = (
  input: TransferInput,
  original: Transfer | null,
): void => {
  const id = input.reversesId;
  if (id === undefined || id === null) return;
  if (original === null) {
    throw new LedgerConflictError(
      input.reference,
      `reverses_id ${id} refers to no transfer`,
    );
  }
  if (!isInverseOf(input, original)) {
    throw new LedgerConflictError(
      input.reference,
      `reverses_id ${id} is not the exact inverse of the original leg`,
    );
  }
};

/**
 * A leg that links to another via `reversesId` must be that original's exact
 * inverse and the original must exist (see {@link assertReversesAgainst}). Reads
 * the original through `read` — used by the single-event write path, which reads
 * through its own transaction.
 */
export const assertReverses = async (
  read: RowReader,
  input: TransferInput,
): Promise<void> => {
  const id = input.reversesId;
  if (id === undefined || id === null) return;
  assertReversesAgainst(input, await selectById(read, id));
};
