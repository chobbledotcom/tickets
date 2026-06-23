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

import { WRITEOFF } from "#shared/accounting/accounts.ts";
import {
  eventGroup,
  legReference,
  type RefPart,
} from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";

/**
 * Post a manual `adjustment` leg that moves `account`'s ledger balance by `delta`
 * (in "credit-the-account" terms):
 *
 * - `delta === 0` → no-op (nothing is posted).
 * - `delta > 0` → credit the account: `WRITEOFF → account`, so `balanceOf(account)`
 *   rises (a listing's income up, a modifier's revenue up, what an attendee is
 *   credited up).
 * - `delta < 0` → debit the account: `account → WRITEOFF`, so `balanceOf(account)`
 *   falls.
 *
 * The amount is `Math.abs(delta)`. Each save is its own business event — a fresh
 * `nowIso()` is mixed into the `eventGroup`/`reference` (built from `keyParts` +
 * the occurredAt) — so editing a figure up, down, then back up posts three
 * distinct adjustments rather than colliding on an earlier event's references.
 * Corrections are appended, never destructive.
 */
export const postWriteoffAdjustment = async (
  account: AccountRef,
  delta: number,
  keyParts: RefPart[],
): Promise<void> => {
  if (delta === 0) return;
  const occurredAt = nowIso();
  const parts: RefPart[] = [...keyParts, occurredAt];
  await postTransfers([
    {
      amount: Math.abs(delta),
      // Crediting the account sources from writeoff (the figure rises);
      // debiting it sinks back to writeoff (the figure falls).
      destination: delta > 0 ? account : WRITEOFF,
      eventGroup: await eventGroup(parts),
      kind: "adjustment",
      occurredAt,
      reference: await legReference(parts),
      source: delta > 0 ? WRITEOFF : account,
    },
  ]);
};
