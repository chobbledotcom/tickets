/**
 * Pure projections over a slice of transfers — the unit-testable heart of the
 * ledger. A site has one currency, fixed at setup and never changed, so every
 * transfer shares it: balances sum amounts directly with no per-row currency to
 * carry or compare.
 */

import { filter } from "#fp";
import { instantToEpochMs } from "#shared/validation/timestamp.ts";
import { accountKey, sameAccount } from "./account.ts";
import type { AccountRef, Transfer } from "./types.ts";

/** Every account's balance, keyed by {@link accountKey}. */
export const allBalances = (transfers: Transfer[]): Map<string, number> => {
  const balances = new Map<string, number>();
  const add = (acct: AccountRef, delta: number): void => {
    const key = accountKey(acct);
    balances.set(key, (balances.get(key) ?? 0) + delta);
  };
  for (const t of transfers) {
    add(t.destination, t.amount);
    add(t.source, -t.amount);
  }
  return balances;
};

/**
 * Net balance of one account: money in (as destination) minus money out (as
 * source). Positive ⇒ the account holds value; negative ⇒ it owes. Reads the
 * one balance algorithm in {@link allBalances}, so a single account is never
 * summed a second, different way.
 */
export const balanceOf =
  (acct: AccountRef) =>
  (transfers: Transfer[]): number =>
    allBalances(transfers).get(accountKey(acct)) ?? 0;

/**
 * One line of an account statement: the transfer, its signed effect on the
 * account, and the running balance after it.
 */
export type StatementLine = {
  readonly transfer: Transfer;
  readonly signed: number;
  readonly running: number;
};

const byOccurredThenId = (a: Transfer, b: Transfer): number =>
  instantToEpochMs(a.occurredAt) - instantToEpochMs(b.occurredAt) ||
  a.id - b.id;

/**
 * A running-balance statement for one account, ordered by business time (as a
 * parsed instant, not a string compare, so any precision sorts correctly) then
 * id, so the running total is meaningful regardless of the order rows arrive in.
 *
 * Pass `openingBalance` when `transfers` is a date-ranged slice rather than the
 * account's full history, so the running total continues from the balance before
 * the window instead of restarting at zero.
 */
export const statementFor =
  (acct: AccountRef, openingBalance = 0) =>
  (transfers: Transfer[]): StatementLine[] => {
    const ordered = filter(
      (t: Transfer) =>
        sameAccount(t.source, acct) || sameAccount(t.destination, acct),
    )(transfers).toSorted(byOccurredThenId);
    let running = openingBalance;
    return ordered.map((transfer) => {
      const signed = sameAccount(transfer.destination, acct)
        ? transfer.amount
        : -transfer.amount;
      running += signed;
      return { running, signed, transfer };
    });
  };
