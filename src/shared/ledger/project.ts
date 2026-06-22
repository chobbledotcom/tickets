/**
 * Pure projections over a slice of transfers — the unit-testable heart of the
 * ledger. Every balance projection refuses to sum across currencies, so the
 * single-currency rule is enforced in code, not just by convention.
 */

import { filter, sumOf, unique } from "#fp";
import { instantToEpochMs, isInstant } from "#shared/validation/timestamp.ts";
import { accountKey, sameAccount } from "./account.ts";
import type { AccountRef, Transfer } from "./types.ts";

/** Distinct currencies present in a slice, in first-seen order. */
export const currenciesIn = (transfers: Transfer[]): string[] =>
  unique(transfers.map((t) => t.currency));

/**
 * Throw if a slice mixes currencies. Every balance projection calls this, so a
 * backfill, a currency change, or a mis-entered manual transfer fails loudly
 * instead of silently adding pence to cents.
 */
export const assertSingleCurrency = (transfers: Transfer[]): void => {
  const currencies = currenciesIn(transfers);
  if (currencies.length > 1) {
    throw new Error(`mixed-currency ledger slice: ${currencies.join(", ")}`);
  }
};

/**
 * Net balance of one account: money in (as destination) minus money out (as
 * source). Positive ⇒ the account holds value; negative ⇒ it owes.
 */
export const balanceOf =
  (acct: AccountRef) =>
  (transfers: Transfer[]): number => {
    assertSingleCurrency(transfers);
    const into = sumOf((t: Transfer) =>
      sameAccount(t.destination, acct) ? t.amount : 0,
    )(transfers);
    const outOf = sumOf((t: Transfer) =>
      sameAccount(t.source, acct) ? t.amount : 0,
    )(transfers);
    return into - outOf;
  };

/** Every account's balance, keyed by {@link accountKey}. */
export const allBalances = (transfers: Transfer[]): Map<string, number> => {
  assertSingleCurrency(transfers);
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

/** Total amount across transfers of one kind (e.g. cash refunded). */
export const sumOfKind =
  (kind: string) =>
  (transfers: Transfer[]): number => {
    assertSingleCurrency(transfers);
    return sumOf((t: Transfer) => (t.kind === kind ? t.amount : 0))(transfers);
  };

/**
 * Transfers whose business time falls in the half-open window [from, to).
 * Bounds are compared as instants, not strings, so a whole-second bound like
 * `2026-02-01T00:00:00Z` still includes the canonical `2026-02-01T00:00:00.000Z`.
 * Invalid bounds are rejected up front via {@link isInstant}, so an impossible
 * date (e.g. `2026-02-30`) can't silently shift the window. An inverted window
 * (`from` after `to`) throws rather than silently returning an empty slice,
 * which would read as zero revenue/refunds for what is really a swapped-argument
 * bug.
 */
export const inPeriod =
  (from: string, to: string) =>
  (transfers: Transfer[]): Transfer[] => {
    if (!isInstant(from) || !isInstant(to)) {
      throw new Error(`inPeriod: invalid bound (from=${from}, to=${to})`);
    }
    const fromMs = instantToEpochMs(from);
    const toMs = instantToEpochMs(to);
    if (fromMs > toMs) {
      throw new Error(`inPeriod: inverted window (from=${from}, to=${to})`);
    }
    return filter((t: Transfer) => {
      const at = instantToEpochMs(t.occurredAt);
      return at >= fromMs && at < toMs;
    })(transfers);
  };

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
    assertSingleCurrency(transfers);
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
