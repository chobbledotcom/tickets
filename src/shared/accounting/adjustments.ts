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

import type { InValue } from "@libsql/client";
import { WRITEOFF } from "#shared/accounting/accounts.ts";
import {
  eventGroup,
  legReference,
  type RefPart,
} from "#shared/accounting/refs.ts";
import { insertStatement, orIgnore } from "#shared/accounting/rows.ts";
import { postTransfersTx } from "#shared/accounting/store.ts";
import type { TxScope } from "#shared/db/client.ts";
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";

/**
 * Build the single `adjustment` leg that moves `account`'s ledger balance by
 * `delta` (in "credit-the-account" terms), or `null` for a zero delta (which
 * posts nothing). Shared by the own-transaction and in-transaction posters so
 * the leg's direction, amount, and reference derivation live in exactly one
 * place. Each save is its own business event — both the `delta` and a fresh
 * `nowIso()` are mixed into the `eventGroup`/`reference` — so editing a figure
 * up, down, then back up posts three distinct adjustments rather than colliding
 * on an earlier event's references. The `delta` is part of the key because
 * `nowIso()` is only millisecond-resolution: two opposite corrections of the
 * same figure (a raise then a lower) posted within the same millisecond would
 * otherwise share `[...keyParts, occurredAt]` and the second would be dropped by
 * the `INSERT OR IGNORE`; including the (signed) delta keeps them distinct.
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
    kind: "adjustment",
    occurredAt,
    reference: await legReference(parts),
    source: delta > 0 ? WRITEOFF : account,
  };
};

/**
 * Post a manual `adjustment` leg that moves `account`'s ledger balance by `delta`
 * (in "credit-the-account" terms) inside an already-open write transaction, so
 * the correction commits or rolls back together with whatever else the
 * transaction does — the status column write in {@link updateAttendeeOrder}, and
 * the in-transaction read of the current projection a correction recomputes its
 * delta against (which makes a re-submitted correction idempotent):
 *
 * - `delta === 0` → no-op (nothing is posted).
 * - `delta > 0` → credit the account: `WRITEOFF → account`, so `balanceOf(account)`
 *   rises (income up, modifier revenue up, an attendee credited).
 * - `delta < 0` → debit the account: `account → WRITEOFF`, so it falls.
 *
 * The amount is `Math.abs(delta)`. Corrections are appended, never destructive.
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
