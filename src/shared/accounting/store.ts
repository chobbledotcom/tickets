/**
 * Write path for the transfers ledger.
 *
 * Posting is idempotent per business event: the legs of one event share an
 * `eventGroup`, and {@link postTransfers} writes that whole set once. If the same
 * event is posted again it must present the exact same legs — a changed, added,
 * or missing leg throws {@link LedgerConflictError} rather than quietly appending
 * to a charge that was already handled.
 *
 * The post runs in one write transaction and reads the already-stored legs
 * through that same transaction. So if two requests post the same event at once,
 * the database write lock makes them take turns: one does the real post, the
 * other sees those rows and replays as a no-op. No half-written event is left
 * behind, so the insert needs no conflict clause.
 *
 * The clock lives here (`recorded_at`); the business time (`occurred_at`) comes
 * from the caller. `memo` is opaque (owner-key ciphertext is non-deterministic,
 * so it is left out of the replay-equality check).
 */

import {
  fromTx,
  insertStatement,
  ledgerCurrency,
  type RowReader,
  selectByEventGroup,
  selectById,
  selectByReferences,
} from "#shared/accounting/rows.ts";
import { type TxScope, withTransaction } from "#shared/db/client.ts";
import { sameAccount } from "#shared/ledger/account.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { validateTransfer } from "#shared/ledger/validate.ts";
import { nowIso } from "#shared/now.ts";

/** Raised when a replayed event differs from what is already stored — a leg
 *  with different money facts, an extra leg, or a missing leg. Surfaced loudly
 *  so a mapper or pricing change can't quietly rewrite a charge already made. */
export class LedgerConflictError extends Error {
  constructor(reference: string, detail: string) {
    super(`ledger conflict on reference "${reference}": ${detail}`);
    this.name = "LedgerConflictError";
  }
}

/** Outcome of {@link postTransfers}: rows newly written vs idempotent replays. */
export type PostResult = {
  readonly inserted: number;
  readonly skipped: number;
};

// Money-defining fields only: `memo` (non-deterministic ciphertext) and the
// write-time `recorded_at`/`posted_by` metadata are not compared on replay.
const kindOf = (t: { kind?: string }): string => t.kind ?? "";
const reversesIdOf = (t: { reversesId?: number }): number | null =>
  t.reversesId ?? null;

const financialMismatches = (
  prior: Transfer,
  input: TransferInput,
): string[] => {
  const checks: [field: string, matches: boolean][] = [
    ["amount", prior.amount === input.amount],
    ["currency", prior.currency === input.currency],
    ["source", sameAccount(prior.source, input.source)],
    ["destination", sameAccount(prior.destination, input.destination)],
    ["occurredAt", prior.occurredAt === input.occurredAt],
    ["kind", kindOf(prior) === kindOf(input)],
    ["reversesId", reversesIdOf(prior) === reversesIdOf(input)],
  ];
  return checks.filter(([, matches]) => !matches).map(([field]) => field);
};

/**
 * Check that a replayed event presents exactly the stored leg set. Throws if the
 * replay omits a stored leg, adds a leg that was never stored, or changes a
 * leg's money facts.
 */
const assertEventMatches = (
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
    const mismatches = financialMismatches(prior, input);
    if (mismatches.length > 0) {
      throw new LedgerConflictError(
        input.reference,
        `stored leg differs in ${mismatches.join(", ")}`,
      );
    }
  }
};

/**
 * Checks that need no database, run before any DB work so a malformed batch never
 * opens a transaction: every leg is valid on its own, the batch shares one event
 * group and one currency (a mixed-currency event passes per-leg validation but
 * would later make every balance projection throw), and no reference is repeated
 * (which would silently under-post).
 */
const assertPostable = (inputs: TransferInput[]): void => {
  for (const input of inputs) {
    const result = validateTransfer(input);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code).join(", ");
      throw new Error(`invalid transfer (${input.reference}): ${codes}`);
    }
  }
  const eventGroups = new Set(inputs.map((t) => t.eventGroup));
  if (eventGroups.size > 1) {
    throw new Error(
      `postTransfers: every leg must share one eventGroup (got ${eventGroups.size})`,
    );
  }
  const currencies = new Set(inputs.map((t) => t.currency));
  if (currencies.size > 1) {
    throw new Error(
      `postTransfers: every leg must share one currency (got ${[
        ...currencies,
      ].join(", ")})`,
    );
  }
  const references = inputs.map((t) => t.reference);
  if (new Set(references).size !== references.length) {
    throw new Error("postTransfers: duplicate reference within one event");
  }
};

/**
 * A leg that links to another via `reversesId` must be that original's exact
 * inverse — same amount and currency, with source and destination swapped — and
 * the original must exist. Otherwise the unique `reverses_id` slot is used up
 * without the original money actually being voided (wrong amount or direction),
 * or it points at nothing, which would permanently block the correct reversal.
 */
const assertReverses = async (
  read: RowReader,
  input: TransferInput,
): Promise<void> => {
  const id = input.reversesId;
  if (id === undefined || id === null) return;
  const original = await selectById(read, id);
  if (original === null) {
    throw new LedgerConflictError(
      input.reference,
      `reverses_id ${id} refers to no transfer`,
    );
  }
  const isInverse =
    input.amount === original.amount &&
    input.currency === original.currency &&
    sameAccount(input.source, original.destination) &&
    sameAccount(input.destination, original.source);
  if (!isInverse) {
    throw new LedgerConflictError(
      input.reference,
      `reverses_id ${id} is not the exact inverse of the original leg`,
    );
  }
};

/**
 * Post the legs of one business event inside an already-open transaction, so the
 * ledger write commits or rolls back together with the domain rows it
 * accompanies (a booking and its sale/payment legs land together or not at all).
 * Same idempotency rules as {@link postTransfers}: if the event is already
 * stored the whole leg set must match, otherwise the legs are inserted. The
 * batch must also be in the currency the ledger already holds. An empty post is
 * a no-op.
 */
export const postTransfersTx = async (
  tx: TxScope,
  inputs: TransferInput[],
): Promise<PostResult> => {
  if (inputs.length === 0) return { inserted: 0, skipped: 0 };
  assertPostable(inputs);
  const eventGroup = inputs[0]!.eventGroup;
  const references = inputs.map((t) => t.reference);
  const read = fromTx(tx);
  const existing = await selectByEventGroup(read, eventGroup);
  if (existing.length > 0) {
    assertEventMatches(eventGroup, existing, inputs);
    return { inserted: 0, skipped: inputs.length };
  }
  // No legs for this event yet, so any already-stored reference belongs to a
  // different event — reject before inserting (naming the exact reference).
  const colliding = await selectByReferences(read, references);
  if (colliding.length > 0) {
    throw new LedgerConflictError(
      colliding[0]!.reference,
      "reference already belongs to a different event",
    );
  }
  // assertPostable checked one currency within the batch; this checks it against
  // the rest of the ledger so the whole history stays single-currency.
  const established = await ledgerCurrency(read);
  if (established !== null && established !== inputs[0]!.currency) {
    throw new LedgerConflictError(
      inputs[0]!.reference,
      `currency ${inputs[0]!.currency} differs from ledger currency ${established}`,
    );
  }
  const recordedAt = nowIso();
  for (const input of inputs) {
    // Check the void link against the stored original before inserting, so a bad
    // reversal never uses up the unique reverses_id slot.
    await assertReverses(read, input);
    await tx.execute(insertStatement(input, recordedAt));
  }
  return { inserted: inputs.length, skipped: 0 };
};

/**
 * Post the legs of one business event in its own write transaction, idempotently.
 * Every leg must share one `eventGroup` and one `currency` and carry a distinct
 * `reference`. Use {@link postTransfersTx} to post within a wider transaction
 * (e.g. together with a booking).
 */
export const postTransfers = (inputs: TransferInput[]): Promise<PostResult> =>
  withTransaction((tx) => postTransfersTx(tx, inputs));
