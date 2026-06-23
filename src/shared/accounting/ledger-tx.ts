/**
 * `ledgerTx` — the one discoverable menu of in-transaction ledger operations.
 *
 * Rather than scatter `…Tx` functions across modules, every way to read, write,
 * or correct the `transfers` ledger inside an already-open write transaction (a
 * `TxScope`) is named here, so autocompleting `ledgerTx.` lists the whole surface
 * in one place. Wrap a call in `withTransaction` — or use {@link inOwnTx} — for a
 * standalone operation. (The pure leg builders `mapBooking`/`mapRefund`, and the
 * own-transaction `postTransfers`, live in their own modules — this is the
 * in-transaction facade. The leaf `…Tx` functions stay where they are implemented
 * and are reached through this facade; the lower-level primitives compose each
 * other directly to avoid an import cycle.)
 *
 * The reads are the in-transaction projections the read-then-write corrections
 * use: a correction reads the current figure under the write lock, computes its
 * delta against the submitted target, and posts — so re-submitting the same
 * target is a no-op. `correct.X` pairs with `read.X`: the read is the figure the
 * correction steers.
 */

import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { postWriteoffAdjustmentTx } from "#shared/accounting/adjustments.ts";
import {
  attendeeOwedTx,
  listingIncomeTx,
  modifierRevenueTx,
} from "#shared/accounting/queries.ts";
import { postTransfersTx } from "#shared/accounting/store.ts";
import { type TxScope, withTransaction } from "#shared/db/client.ts";
import type { AccountRef } from "#shared/ledger/types.ts";

/**
 * Build an in-transaction correction for one operator-set figure: read the
 * current projection under the write lock, then post the single `writeoff`
 * adjustment (decision 14) that moves it onto `target`. Reading and posting
 * through the same `tx` makes re-submitting the same target a no-op — the second
 * read sees the first's leg and computes a zero delta — and serialises concurrent
 * submits on the write lock instead of both appending the delta and overshooting.
 *
 * `toCredit` turns (current, target) into the credit the account needs: a figure
 * that IS the account balance (a listing's income, a modifier's revenue) moves
 * with `target − current`; what an attendee owes is the balance's NEGATION, so it
 * moves with `current − target` (crediting the attendee lowers what's owed). The
 * adjustment sources/sinks at `writeoff`, never external cash, so cash reports
 * (`world→*`) stay honest.
 */
const corrector =
  (
    read: (tx: TxScope, id: number) => Promise<number>,
    account: (id: number) => AccountRef,
    keyPrefix: string,
    toCredit: (current: number, target: number) => number,
  ) =>
  async (tx: TxScope, id: number, target: number): Promise<void> => {
    const current = await read(tx, id);
    await postWriteoffAdjustmentTx(tx, account(id), toCredit(current, target), [
      keyPrefix,
      id,
    ]);
  };

/** Credit to move a figure that IS the account balance onto `target`. */
const toBalance = (current: number, target: number): number => target - current;
/** Credit to move what's owed (the account balance's NEGATION) onto `target`. */
const toOwed = (current: number, target: number): number => current - target;

export const ledgerTx = {
  /** Post a manual `writeoff` adjustment moving an account's balance by `delta`
   *  (in "credit-the-account" terms; a zero delta posts nothing). */
  adjust: postWriteoffAdjustmentTx,
  /** Read-then-adjust corrections that move a projected figure onto a target,
   *  symmetric with {@link ledgerTx.read} (each `read.X` is the figure `correct.X`
   *  steers). Re-submitting the same target posts nothing. */
  correct: {
    /** Correct a listing's recognised income to a target. */
    income: corrector(
      listingIncomeTx,
      revenueAccount,
      "income-adjust",
      toBalance,
    ),
    /** Correct a modifier's net revenue to a target. */
    modifierRevenue: corrector(
      modifierRevenueTx,
      modifierAccount,
      "modifier-revenue-adjust",
      toBalance,
    ),
    /** Correct what an attendee owes to a target. */
    owed: corrector(attendeeOwedTx, attendeeAccount, "balance-adjust", toOwed),
  },
  /** Post pre-built legs — the primitive every other write composes. */
  post: postTransfersTx,
  /** In-transaction projection reads, for read-then-write corrections. */
  read: {
    /** A listing's recognised income (gross credits less write-off debits). */
    income: listingIncomeTx,
    /** A modifier's net revenue (balanceOf(modifier)). */
    modifierRevenue: modifierRevenueTx,
    /** What an attendee currently owes (−balanceOf(attendee)). */
    owed: attendeeOwedTx,
  },
};

/**
 * Adapt an in-transaction correction (`ledgerTx.correct.X`) into a standalone
 * call that opens its own write transaction — for the admin "adjust this figure"
 * forms that correct a single figure outside any larger unit of work.
 */
export const inOwnTx =
  (correct: (tx: TxScope, id: number, target: number) => Promise<void>) =>
  (id: number, target: number): Promise<void> =>
    withTransaction((tx) => correct(tx, id, target));
