/**
 * SQL-fragment builders for projecting figures off the `transfers` ledger at
 * read time (income, amount paid, refund status, …). These centralise the
 * transfers-table column names and the integer-id → TEXT cast in one place.
 * Every projection then filters accounts identically, and a typo in `source_id`
 * / `dest_type` / the `CAST(… AS TEXT)` cannot silently skew a single read.
 *
 * An account id here is a statement: a column of the surrounding query, such
 * as `listingAttendee.attendee_id`, or a bound id.
 */

import {
  ATTENDEE,
  MODIFIER,
  REVENUE,
  WORLD,
  WRITEOFF_TYPE,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { MANUAL_ATTENDEE_CHARGE } from "#accounting/manual-entries.ts";
import { type SqlStatement, sql, sqlCommas, sqlLiteral } from "#db/sql.ts";

/** Account type/id columns for one leg side of a `transfers` row — the single
 *  home for these names. Every projection (the interpolated subqueries here
 *  AND the parameterised balance reads in `./queries.ts`) refers to them once. */
export const LEG_COLUMNS = {
  dest: { id: sql`dest_id`, type: sql`dest_type` },
  source: { id: sql`source_id`, type: sql`source_type` },
} as const;

/**
 * A `transfers` account-match predicate for one leg side: `<role>_type = '<type>'
 * AND <role>_id = CAST(<idExpr> AS TEXT)`. `role` picks the source or destination
 * side. `type` is the account type (`'attendee'`, `'revenue'`, …). `idExpr` is
 * the SQL for the account id in the surrounding query. Ledger ids are stored as
 * TEXT, so the id expression is CAST so an integer column still matches.
 */
export const accountPredicate = (
  role: "source" | "dest",
  type: string,
  idExpr: SqlStatement,
): SqlStatement => {
  const col = LEG_COLUMNS[role];
  return sql`${col.type} = ${sqlLiteral(type)} AND ${col.id} = CAST(${idExpr} AS TEXT)`;
};

/**
 * Predicate matching a booking row's gross `sale` leg: `kind='sale'`, billed from
 * the attendee to the listing's revenue account, scoped to the row's
 * `ledger_event_group`. The single home for "this row's sale leg" — shared by the
 * per-row amount-paid projection (`pricePaidFromLedger`) and the paid-line
 * existence check, so the two cannot drift. No leading `WHERE`.
 */
/** SQL keyed by the three ledger columns a booking's legs carry: the
 * attendee, the listing's revenue account, and the booking's event group. */
export type BookingLegSql = (
  attendeeIdExpr: SqlStatement,
  listingIdExpr: SqlStatement,
  eventGroupExpr: SqlStatement,
) => SqlStatement;

export const saleLegPredicate: BookingLegSql = (
  attendeeIdExpr,
  listingIdExpr,
  eventGroupExpr,
) =>
  sql`kind = ${sqlLiteral(KIND.sale)} AND ${accountPredicate(
    "source",
    ATTENDEE,
    attendeeIdExpr,
  )} AND ${accountPredicate(
    "dest",
    REVENUE,
    listingIdExpr,
  )} AND event_group = ${eventGroupExpr}`;

/** One booking's recognised ticket price, including signed tax corrections. */
export const bookingSaleTotalSubquery: BookingLegSql = (
  attendeeIdExpr,
  listingIdExpr,
  eventGroupExpr,
) => {
  const credit = sql`${accountPredicate("source", ATTENDEE, attendeeIdExpr)} AND ${accountPredicate("dest", REVENUE, listingIdExpr)}`;
  const debit = sql`${accountPredicate("dest", ATTENDEE, attendeeIdExpr)} AND ${accountPredicate("source", REVENUE, listingIdExpr)}`;
  const original = sql`(${saleLegPredicate(attendeeIdExpr, listingIdExpr, eventGroupExpr)})`;
  const correction = sql`(kind = ${sqlLiteral(KIND.taxSale)} AND event_group IN (SELECT assessment.event_group FROM booking_tax_assessments AS assessment WHERE assessment.booking_group = ${eventGroupExpr}) AND ((${credit}) OR (${debit})))`;
  return sql`(SELECT ${signedSumCase(credit, debit)} FROM transfers WHERE ${original} OR ${correction})`;
};

/** Recognised income includes signed tax reclassifications and write-offs.
 * Refunds leave that historical earned amount unchanged. */
export const creditsLessWriteoffDebits = (
  type: string,
  idExpr: SqlStatement,
): SqlStatement => {
  const credited = sql`${accountPredicate("dest", type, idExpr)} AND (kind IS NULL OR kind NOT IN (${sqlLiteral(KIND.refundTaxSale)}, ${sqlLiteral(KIND.refundTaxModifier)}))`;
  const writtenOff = sql`${accountPredicate("source", type, idExpr)} AND (dest_type = ${sqlLiteral(WRITEOFF_TYPE)} OR kind IN (${sqlLiteral(KIND.taxSale)}, ${sqlLiteral(KIND.taxModifier)}))`;
  return sql`(SELECT COALESCE(SUM(CASE WHEN ${credited} THEN amount WHEN ${writtenOff} THEN -amount ELSE 0 END), 0) FROM transfers WHERE ${credited} OR ${writtenOff})`;
};

/**
 * The bare signed-sum aggregate every net-balance read shares:
 * amounts matching `plus` add, amounts matching `minus` subtract, zero when no
 * leg matches either. The single home for the ledger's sign convention in SQL.
 * {@link accountBalanceSubquery}, the parameterised `accountBalance`, and the
 * `ledgerTotals` due/fees columns all render from it, so no two balance reads
 * can disagree on which side credits.
 */
export const signedSumCase = (
  plus: SqlStatement,
  minus: SqlStatement,
): SqlStatement =>
  sql`COALESCE(SUM(CASE WHEN ${plus} THEN amount WHEN ${minus} THEN -amount ELSE 0 END), 0)`;

/** A booking order's `modifier` legs, as fragments over one `transfers` row.
 *  A surcharge credits the modifier's account, which is the destination side.
 *  A discount debits it, which is the source side. `accountId` reads whichever
 *  side holds the modifier, and `signedAmount` reads the effect on the price:
 *  positive for a surcharge and negative for a discount. Both use
 *  {@link LEG_COLUMNS} and {@link signedSumCase}, so a read cannot disagree
 *  with the legs the booking mapper posts. */
const surchargeSide = sql`${LEG_COLUMNS.dest.type} = ${sqlLiteral(MODIFIER)}`;
const discountSide = sql`${LEG_COLUMNS.source.type} = ${sqlLiteral(MODIFIER)}`;

export const modifierLeg = {
  accountId: sql`CASE WHEN ${surchargeSide} THEN ${LEG_COLUMNS.dest.id} ELSE ${LEG_COLUMNS.source.id} END`,
  filter: sql`kind = ${sqlLiteral(KIND.modifier)}`,
  signedAmount: signedSumCase(surchargeSide, discountSide),
} as const;

/**
 * A *bare* scalar subquery (no alias) for an account's net ledger balance: money
 * in as the destination minus money out as the source. It is the same signed
 * sum the TS-side `balanceOf` computes. The caller names it and chooses the sign: a
 * revenue/modifier account reads it directly (`balance AS income`), while an
 * "owed" figure negates it (outstanding = `-balance`). Scanning only the
 * account's own legs (`<dest> OR <source>`) keeps it index-backed.
 */
export const accountBalanceSubquery = (
  type: string,
  idExpr: SqlStatement,
): SqlStatement => {
  const asDest = accountPredicate("dest", type, idExpr);
  const asSource = accountPredicate("source", type, idExpr);
  return sql`(SELECT ${signedSumCase(asDest, asSource)} FROM transfers WHERE ${asDest} OR ${asSource})`;
};

/** Net cash received from the outside world by one account. Payments into the
 * account add. Refunds and reversals back to the world subtract. Other ledger
 * legs do not represent cash and are ignored. */
export const externalCashBalanceSubquery = (
  type: string,
  idExpr: SqlStatement,
): SqlStatement => {
  const accountIn = accountPredicate("dest", type, idExpr);
  const accountOut = accountPredicate("source", type, idExpr);
  const worldOut = sql`source_type = ${sqlLiteral(WORLD.type)} AND source_id = ${sqlLiteral(WORLD.id)}`;
  const worldIn = sql`dest_type = ${sqlLiteral(WORLD.type)} AND dest_id = ${sqlLiteral(WORLD.id)}`;
  const received = sql`${accountIn} AND ${worldOut}`;
  const returned = sql`${accountOut} AND ${worldIn}`;
  return sql`(SELECT ${signedSumCase(received, returned)} FROM transfers WHERE ${received} OR ${returned})`;
};

const billedTotalSubquery = (
  type: string,
  idExpr: SqlStatement,
  kinds: readonly string[],
): SqlStatement => {
  const billed = accountPredicate("source", type, idExpr);
  const discounted = accountPredicate("dest", type, idExpr);
  const kindList = sqlCommas(kinds.map(sqlLiteral));
  return sql`(SELECT ${signedSumCase(billed, discounted)} FROM transfers WHERE kind IN (${kindList}) AND (${billed} OR ${discounted}))`;
};

/** The kinds that bill the customer for the booking itself, in the order the
 * subtotal reads them. Booking fees and later manual charges extend it. */
const TAXED_SALE_KINDS = [
  KIND.sale,
  KIND.modifier,
  KIND.taxSale,
  KIND.taxModifier,
  KIND.vat,
] as const;

/** Customer subtotal including tax, before booking fees. This is the base used
 * to calculate a reservation deposit. */
export const reservationSubtotalSubquery = (
  type: string,
  idExpr: SqlStatement,
): SqlStatement => billedTotalSubquery(type, idExpr, TAXED_SALE_KINDS);

/** Total amount billed to one attendee. Booking fees and later manual charges
 * add to the saved ticket subtotal. Payments, refunds and write-offs do not. */
export const orderTotalSubquery = (
  type: string,
  idExpr: SqlStatement,
): SqlStatement =>
  billedTotalSubquery(type, idExpr, [
    ...TAXED_SALE_KINDS,
    KIND.fee,
    MANUAL_ATTENDEE_CHARGE,
  ]);

/**
 * The bare subquery for what an attendee still owes: the negation of their net
 * account balance (outstanding = −balance). The single place the "owed equals
 * negative balance" sign convention lives, so the read column, the settle guard,
 * and the finalize guard cannot drift apart. Callers alias it
 * (`… AS remaining_balance`) or compare it in a guard.
 */
export const attendeeOwedSubquery = (idExpr: SqlStatement): SqlStatement =>
  sql`-${accountBalanceSubquery(ATTENDEE, idExpr)}`;
