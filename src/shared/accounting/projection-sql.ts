/**
 * SQL-fragment builders for projecting figures off the `transfers` ledger at
 * read time (income, amount paid, refund status, …). These centralise the
 * transfers-table column names and the integer-id → TEXT cast in one place, so
 * every projection filters accounts identically and a typo in `source_id` /
 * `dest_type` / the `CAST(… AS TEXT)` can't silently skew a single read.
 *
 * They build raw SQL by interpolating caller-supplied column *expressions*
 * (e.g. `listingAttendee.attendee_id`), not bound values — for binding a known account use
 * the parameterised `transfersByAccount` in `./queries.ts` instead.
 */

import {
  ATTENDEE,
  REVENUE,
  WORLD,
  WRITEOFF_TYPE,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";

/** Account type/id columns for one leg side of a `transfers` row — the single
 *  home for these names, so every projection (the interpolated subqueries here
 *  AND the parameterised balance reads in `./queries.ts`) refers to them once. */
export const LEG_COLUMNS = {
  dest: { id: "dest_id", type: "dest_type" },
  source: { id: "source_id", type: "source_type" },
} as const;

/**
 * A `transfers` account-match predicate for one leg side: `<role>_type = '<type>'
 * AND <role>_id = CAST(<idExpr> AS TEXT)`. `role` picks the source or destination
 * side; `type` is the account type (`'attendee'`, `'revenue'`, …); `idExpr` is
 * the SQL for the account id in the surrounding query. Ledger ids are stored as
 * TEXT, so the id expression is CAST so an integer column still matches.
 */
export const accountPredicate = (
  role: "source" | "dest",
  type: string,
  idExpr: string,
): string => {
  const col = LEG_COLUMNS[role];
  return `${col.type} = '${type}' AND ${col.id} = CAST(${idExpr} AS TEXT)`;
};

/**
 * Predicate matching a booking row's gross `sale` leg: `kind='sale'`, billed from
 * the attendee to the listing's revenue account, scoped to the row's
 * `ledger_event_group`. The single home for "this row's sale leg" — shared by the
 * per-row amount-paid projection (`pricePaidFromLedger`) and the paid-line
 * existence check, so the two can't drift. All three args are SQL column
 * expressions in the surrounding query (no leading `WHERE`).
 */
export const saleLegPredicate = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  eventGroupExpr: string,
): string =>
  `kind = '${KIND.sale}'` +
  ` AND ${accountPredicate("source", ATTENDEE, attendeeIdExpr)}` +
  ` AND ${accountPredicate("dest", REVENUE, listingIdExpr)}` +
  ` AND event_group = ${eventGroupExpr}`;

/**
 * A *bare* scalar subquery (no alias — the caller names it, like
 * {@link accountBalanceSubquery}) for the GROSS credits to an account *minus*
 * only its write-off debits. Income is the gross sum of revenue credits
 * (deliberately NOT `balanceOf`, so an ordinary refund — `revenue:L→attendee` —
 * does not reduce it, matching the legacy `SUM(price_paid)`), but a *manual*
 * write-off (`revenue:L→writeoff`, decision 14) must lower it. So this sums the
 * dest-side credits and subtracts the amounts the account paid out specifically
 * to the `writeoff` contra account, ignoring every other source-side leg. With
 * zero `writeoff` legs (production today) it equals the plain gross credit sum.
 * `idExpr` is the SQL for the account id in the surrounding query.
 */
export const creditsLessWriteoffDebits = (
  type: string,
  idExpr: string,
): string => {
  const credited = accountPredicate("dest", type, idExpr);
  const writtenOff = `${accountPredicate("source", type, idExpr)} AND dest_type = '${WRITEOFF_TYPE}'`;
  return (
    "(SELECT COALESCE(SUM(" +
    `CASE WHEN ${credited} THEN amount WHEN ${writtenOff} THEN -amount ELSE 0 END` +
    `), 0) FROM transfers WHERE ${credited} OR ${writtenOff})`
  );
};

/**
 * The bare signed-sum aggregate every net-balance read shares:
 * amounts matching `plus` add, amounts matching `minus` subtract, zero when no
 * leg matches either. The single home for the ledger's sign convention in SQL —
 * {@link accountBalanceSubquery}, the parameterised `accountBalance`, and the
 * `ledgerTotals` due/fees columns all render from it, so no two balance reads
 * can disagree on which side credits. Predicates are SQL fragment bodies and may
 * carry `?` placeholders bound by the caller.
 */
export const signedSumCase = (plus: string, minus: string): string =>
  `COALESCE(SUM(CASE WHEN ${plus} THEN amount` +
  ` WHEN ${minus} THEN -amount ELSE 0 END), 0)`;

/**
 * A *bare* scalar subquery (no alias) for an account's net ledger balance: money
 * in as the destination minus money out as the source — the same signed sum the
 * TS-side `balanceOf` computes. The caller names it and chooses the sign: a
 * revenue/modifier account reads it directly (`balance AS income`), while an
 * "owed" figure negates it (outstanding = `-balance`). Scanning only the
 * account's own legs (`<dest> OR <source>`) keeps it index-backed.
 */
export const accountBalanceSubquery = (
  type: string,
  idExpr: string,
): string => {
  const asDest = accountPredicate("dest", type, idExpr);
  const asSource = accountPredicate("source", type, idExpr);
  return `(SELECT ${signedSumCase(asDest, asSource)} FROM transfers WHERE ${asDest} OR ${asSource})`;
};

/** Net cash received from the outside world by one account. Payments into the
 * account add; refunds and reversals back to the world subtract. Other ledger
 * legs do not represent cash and are ignored. */
export const externalCashBalanceSubquery = (
  type: string,
  idExpr: string,
): string => {
  const accountIn = accountPredicate("dest", type, idExpr);
  const accountOut = accountPredicate("source", type, idExpr);
  const worldOut = `source_type = '${WORLD.type}' AND source_id = '${WORLD.id}'`;
  const worldIn = `dest_type = '${WORLD.type}' AND dest_id = '${WORLD.id}'`;
  const received = `${accountIn} AND ${worldOut}`;
  const returned = `${accountOut} AND ${worldIn}`;
  return `(SELECT ${signedSumCase(received, returned)} FROM transfers WHERE ${received} OR ${returned})`;
};

/**
 * The bare subquery for what an attendee still owes: the negation of their net
 * account balance (outstanding = −balance). The single place the "owed equals
 * negative balance" sign convention lives, so the read column, the settle guard,
 * and the finalize guard can't drift apart. Callers alias it
 * (`… AS remaining_balance`) or compare it in a guard (`… = ?`).
 */
export const attendeeOwedSubquery = (idExpr: string): string =>
  `-${accountBalanceSubquery(ATTENDEE, idExpr)}`;
