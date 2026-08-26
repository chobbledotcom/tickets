/**
 * Manual money corrections — the shared `writeoff` adjustment poster.
 *
 * Every operator-set money figure (a listing's income, a modifier's revenue, an
 * attendee's outstanding balance) projects from the `transfers` ledger now, so a
 * correction can no longer be a column write. Instead it posts a single
 * `adjustment` leg between the figure's account and the `writeoff` contra-revenue
 * account (decision 14), computed as the delta from the current projection. The
 * correction sources/sinks at `writeoff`, never external cash, so cash reports
 * (`world→*`) stay honest — see {@link WRITEOFF}.
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { WRITEOFF } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { eventGroup, legReference, type RefPart } from "#accounting/refs.ts";
import { insertStatement } from "#accounting/rows.ts";
/* jscpd:ignore-end */
import { postTransfersTx } from "#accounting/store.ts";
import { orIgnore, type TxScope } from "#db/client.ts";
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";

/**
 * Each save is its own business event, so both the `delta` and a fresh
 * `nowIso()` are mixed into the `eventGroup` and `reference`. An operator who
 * edits a figure up, down, then back up posts three distinct adjustments.
 *
 * The `delta` is part of the key because `nowIso()` resolves only to the
 * millisecond. Two opposite corrections in the same millisecond would otherwise
 * share a reference, and `INSERT OR IGNORE` would drop the second.
 */
const writeoffAdjustmentLeg = async (
  account: AccountRef,
  delta: number,
  keyParts: RefPart[],
): Promise<TransferInput | null> => {
  if (delta === 0) return null;
  const occurredAt = nowIso();
  const parts: RefPart[] = [...keyParts, delta, occurredAt];
  return {
    amount: Math.abs(delta),
    // Crediting the account sources from writeoff (the figure rises);
    // debiting it sinks back to writeoff (the figure falls).
    destination: delta > 0 ? account : WRITEOFF,
    eventGroup: await eventGroup(parts),
    kind: KIND.adjustment,
    occurredAt,
    reference: await legReference(parts),
    source: delta > 0 ? WRITEOFF : account,
  };
};

/**
 * `delta` is in "credit-the-account" terms: positive credits the account
 * (`WRITEOFF → account`), negative debits it. Zero posts nothing.
 *
 * It runs inside an already-open write transaction, so the correction commits
 * or rolls back with the status write beside it, and the in-transaction read
 * makes a re-submitted correction idempotent.
 *
 * Corrections are appended, never destructive.
 */
export const postWriteoffAdjustmentTx = async (
  tx: TxScope,
  account: AccountRef,
  delta: number,
  keyParts: RefPart[],
): Promise<void> => {
  const leg = await writeoffAdjustmentLeg(account, delta, keyParts);
  if (leg) await postTransfersTx(tx, [leg]);
};

/** One writeoff adjustment to post: which account, by how much, keyed by parts. */
export type WriteoffAdjustment = {
  account: AccountRef;
  delta: number;
  keyParts: RefPart[];
};

/**
 * Build the `INSERT OR IGNORE` statements for a set of writeoff adjustments, so a
 * caller can fold them into a wider batch — an attendee merge posts a reversal per
 * discarded booking — instead of posting each through its own in-transaction
 * read-then-write (which held the write lock open per leg, the "Transaction
 * timed-out" shape). Each adjustment is its own event (a fresh `nowIso`
 * `eventGroup`/`reference`), so idempotency rides the unique `reference` and no
 * pre-write conflict read is needed; a zero delta posts nothing.
 */
export const writeoffAdjustmentInserts = async (
  adjustments: WriteoffAdjustment[],
  recordedAt: string,
): Promise<{ sql: string; args: InValue[] }[]> => {
  const legs = await Promise.all(
    adjustments.map((a) =>
      writeoffAdjustmentLeg(a.account, a.delta, a.keyParts),
    ),
  );
  return legs.flatMap((leg) =>
    leg === null ? [] : [orIgnore(insertStatement(leg, recordedAt))],
  );
};
