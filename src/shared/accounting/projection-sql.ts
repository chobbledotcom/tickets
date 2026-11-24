/**
 * Reads that project figures off the `transfers` ledger at read time: income,
 * amount paid, refund status, and the rest. One place holds the names of the
 * ledger columns and the cast of an integer id to TEXT. Every projection then
 * filters accounts the same way.
 *
 * A test of one ledger row takes the row as a node. A figure is a read of its
 * own. The reads call the ledger `leg`, a word that no other read uses, so a
 * figure inside another statement hides no table of that statement.
 */

import { ATTENDEE, MODIFIER, REVENUE, WORLD } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { MANUAL_ATTENDEE_CHARGE } from "#accounting/manual-entries.ts";
import {
  among,
  amongConstants,
  and,
  type Counted,
  type Expr,
  equal,
  inQuery,
  literal,
  minus,
  type Operand,
  or,
  orZero,
  valued,
  when,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { bindFirst } from "#shared/fp-bind.ts";

/** One row of the ledger, as a test or a figure reads it. */
export type Leg = Node<"transfers">;

/** A test of one ledger row. */
export type LegTest = (leg: Leg) => Expr<boolean>;

/** The ledger rows, under the word every ledger read uses. */
export const ledgerLegs = () => from(tables.transfers).as("leg");

/** An account id in SQL: a column or a value of the surrounding statement, or
 *  text to bind. A bound number is refused. libsql binds a number as a float,
 *  and the CAST of a float gives `5.0`, which matches no account. */
export type AccountId = Expr<number | string | null> | string;

/** The side of a ledger row that an account sits on. */
export type Role = "source" | "dest";

/** Ledger ids are TEXT, so an integer column is CAST to match. */
const asText = (id: AccountId): Expr<string> =>
  valued(sql`CAST(${id} AS TEXT)`);

/** The row has an account of `type` on its `role` side, and its id passes
 *  `idTest`. */
const onSideWhere =
  (
    role: Role,
    type: Operand<string>,
    idTest: (id: Expr<string>) => Expr<boolean>,
  ): LegTest =>
  (leg) =>
    and(equal(leg[`${role}Type`], type), idTest(leg[`${role}Id`]));

/** The row has this account type and this account id on its `role` side. */
export const onSide = (
  role: Role,
  type: Operand<string>,
  id: Operand<string>,
): LegTest => onSideWhere(role, type, (column) => equal(column, id));

/** The row has an account of `type` with one of `ids` on its `role` side. The
 *  type and the ids are bound, so a caller can pass an account from a
 *  request. */
export const sideAmong = (
  role: Role,
  type: Operand<string>,
  ids: readonly string[],
): LegTest => onSideWhere(role, type, (column) => among(column, ids));

/** The row has the account on its `role` side. The type is a constant of the
 *  code, written into the SQL text. */
export const onAccount = (role: Role, type: string, id: AccountId): LegTest =>
  onSide(role, literal(type), asText(id));

export const ofKind =
  (kind: string): LegTest =>
  (leg) =>
    equal(leg.kind, literal(kind));

const inEventGroup =
  (eventGroup: Operand<string>): LegTest =>
  (leg) =>
    equal(leg.eventGroup, eventGroup);

/** The row passes every test. */
export const every =
  (...tests: readonly LegTest[]): LegTest =>
  (leg) =>
    and(...tests.map((test) => test(leg)));

/** The row passes some test. */
export const some =
  (...tests: readonly LegTest[]): LegTest =>
  (leg) =>
    or(...tests.map((test) => test(leg)));

/** A value keyed by the three ledger facts a booking's legs carry: the
 * attendee, the listing's revenue account, and the booking's event group. */
type OfBooking<Value> = (
  attendeeId: AccountId,
  listingId: AccountId,
  eventGroup: Operand<string>,
) => Value;

/** A value of one account. */
type OfAccount<Value> = (type: string, id: AccountId) => Value;

/** The row bills the attendee for the listing. */
const billedForListing = (attendeeId: AccountId, listingId: AccountId) =>
  every(
    onAccount("source", ATTENDEE, attendeeId),
    onAccount("dest", REVENUE, listingId),
  );

/**
 * The gross `sale` leg of a booking row: billed from the attendee to the
 * revenue account of the listing, in the `ledger_event_group` of the row. The
 * amount-paid projection and the paid-line check share it, so the two cannot
 * drift.
 */
export const saleLeg: OfBooking<LegTest> = (
  attendeeId,
  listingId,
  eventGroup,
) =>
  every(
    ofKind(KIND.sale),
    billedForListing(attendeeId, listingId),
    inEventGroup(eventGroup),
  );

/** Whether a booking has a payment leg: money that the attendee received for
 * the booking's event group. */
export const paymentLegExists = (
  attendeeId: AccountId,
  eventGroup: Operand<string>,
): Expr<boolean> =>
  ledgerLegs()
    .where(
      every(
        ofKind(KIND.payment),
        onAccount("dest", ATTENDEE, attendeeId),
        inEventGroup(eventGroup),
      ),
    )
    .exists();

/** A value of one row with the sign of the ledger: `adds` adds, and
 * `subtracts` subtracts. */
type Signed<Value> = (
  adds: LegTest,
  subtracts: LegTest,
) => (leg: Leg) => Expr<Value>;

/**
 * The signed sum every net-balance read shares. Amounts on rows that pass
 * `adds` add, and amounts on rows that pass `subtracts` subtract. The sum is
 * zero when no row passes. The one home for the sign convention of the ledger
 * in SQL, so no two balance reads can disagree on which side credits.
 */
export const signedSum: Signed<Counted> = (adds, subtracts) => (leg) =>
  foldOf(net(adds, subtracts), leg, true);

/** The amount of one row with the sign of {@link signedSum}. */
const signedAmount: Signed<number> = (adds, subtracts) => (leg) =>
  minus(amountWhen(adds)(leg), amountWhen(subtracts)(leg));

/** The amount of a row that passes `test`, else zero. A row between two
 * accounts of one set passes both sides of a figure, so it cancels. */
const amountWhen =
  (test: LegTest) =>
  (leg: Leg): Expr<number> =>
    when<number>([[test(leg), leg.amount]], literal(0));

/** How a measure folds its rows into one value. */
type Fold = "count" | "largest" | "sum";

/** One figure over the ledger: the rows that it reads, the value of each row,
 * and how the values fold into one. A read of several measures makes one pass
 * over the rows that any of them reads, and each measure folds only its own. */
export type Measure<Value> = {
  readonly fold: Fold;
  readonly rows: LegTest;
  readonly value: (leg: Leg) => Expr<number>;
  /** Phantom: the type that the folded value reads as. */
  readonly folded?: Value;
};

/** The rows that add, less the rows that subtract. Zero with no row. The
 * measure reads `rows`, by default the rows that add or subtract. A row that
 * does neither counts zero. */
export const net = (
  adds: LegTest,
  subtracts: LegTest,
  rows: LegTest = some(adds, subtracts),
): Measure<Counted> => ({
  fold: "sum",
  rows,
  value: signedAmount(adds, subtracts),
});

/** The amounts of the rows that pass `rows`, added up. Zero with no row. */
export const amountOf = (rows: LegTest): Measure<Counted> => ({
  fold: "sum",
  rows,
  value: (leg) => leg.amount,
});

/** How many rows pass `rows`. */
export const countOf = (rows: LegTest): Measure<Counted> => ({
  fold: "count",
  rows,
  value: () => literal(1),
});

/** The largest `value` among the rows that pass `rows`, or null with no row. */
export const largestOf = (
  rows: LegTest,
  value: (leg: Leg) => Expr<number>,
): Measure<number | null> => ({ fold: "largest", rows, value });

const FOLDS: Record<
  Fold,
  (value: Expr<number>, only: SqlStatement) => Expr<Counted | null>
> = {
  count: (_value, only) => valued(sql`COUNT(*)${only}`),
  largest: (value, only) => valued(sql`MAX(${value})${only}`),
  sum: (value, only) => orZero(valued(sql`SUM(${value})${only}`)),
};

/** The folded value of `measure` over a read of `leg`. With `alone`, the read
 * keeps only the rows of the measure. Otherwise the fold filters them. */
export const foldOf = <Value>(
  measure: Measure<Value>,
  leg: Leg,
  alone: boolean,
): Expr<Value> =>
  FOLDS[measure.fold](
    measure.value(leg),
    alone ? sql`` : sql` FILTER (WHERE ${measure.rows(leg)})`,
  ) as Expr<Value>;

/** One measure as a value of another statement. The read keeps only the rows
 * of the measure, so an index backs it. */
export const measureOf = <Value>(measure: Measure<Value>): Expr<Value> =>
  ledgerLegs()
    .where(measure.rows)
    .aggregate((leg) => foldOf(measure, leg, true));

/** Which accounts a figure covers, as a test of each side of a row. */
export type Accounts = (role: Role) => LegTest;

/** One account. */
export const oneAccount =
  (type: string, id: AccountId): Accounts =>
  (role) =>
    onAccount(role, type, id);

/** The accounts of `type` with one of `ids`. */
export const accountsAmong =
  (type: Operand<string>, ids: readonly string[]): Accounts =>
  (role) =>
    sideAmong(role, type, ids);

/** Every account of `type`. */
export const everyAccountOf =
  (type: string): Accounts =>
  (role) =>
  (leg) =>
    equal(leg[`${role}Type`], literal(type));

/** The row has one of the accounts on either side. */
export const touching = (accounts: Accounts): LegTest =>
  some(accounts("dest"), accounts("source"));

/** Money in as the destination, less money out as the source. */
export const balanceIn = (accounts: Accounts): Measure<Counted> =>
  net(accounts("dest"), accounts("source"));

/** The row has the outside world on its `role` side. */
const onWorld = (role: Role): LegTest =>
  onSide(role, literal(WORLD.type), literal(WORLD.id));

/** A payment: money from the outside world into one of the accounts. */
export const paidIn = (accounts: Accounts): LegTest =>
  every(accounts("dest"), onWorld("source"));

/** Net cash from the outside world: payments in, less refunds back out. Other
 * ledger legs do not represent cash. */
export const externalCashOf = (accounts: Accounts): Measure<Counted> =>
  net(paidIn(accounts), every(accounts("source"), onWorld("dest")));

/** One booking's recognised ticket price, including signed tax corrections. */
export const bookingSaleTotalSubquery: OfBooking<Expr<Counted>> = (
  attendeeId,
  listingId,
  eventGroup,
) => {
  const credit = billedForListing(attendeeId, listingId);
  const debit = every(
    onAccount("dest", ATTENDEE, attendeeId),
    onAccount("source", REVENUE, listingId),
  );
  const correctedGroups = from(tables.booking_tax_assessments)
    .where((assessment) => equal(assessment.bookingGroup, eventGroup))
    .values((assessment) => assessment.eventGroup);
  const correction: LegTest = (leg) =>
    and(
      ofKind(KIND.taxSale)(leg),
      inQuery(leg.eventGroup, correctedGroups),
      some(credit, debit)(leg),
    );
  return measureOf(
    net(
      credit,
      debit,
      some(saleLeg(attendeeId, listingId, eventGroup), correction),
    ),
  );
};

/** A booking order's `modifier` legs, as tests and values over one ledger
 *  row. A surcharge credits the modifier's account, which is the destination
 *  side. A discount debits it, which is the source side. `accountId` reads
 *  whichever side holds the modifier, and `signedAmount` reads the effect on
 *  the price: positive for a surcharge and negative for a discount. */
const surchargeSide: LegTest = (leg) => equal(leg.destType, literal(MODIFIER));
const discountSide: LegTest = (leg) => equal(leg.sourceType, literal(MODIFIER));

export const modifierLeg = {
  accountId: (leg: Leg): Expr<string> =>
    when<string>([[surchargeSide(leg), leg.destId]], leg.sourceId),
  filter: ofKind(KIND.modifier),
  signedAmount: signedSum(surchargeSide, discountSide),
} as const;

/**
 * The net ledger balance of an account: money in as the destination less money
 * out as the source. It is the same signed sum that the TS-side `balanceOf`
 * computes. The caller names it and chooses the sign: a revenue or modifier
 * account reads it as it is, and an "owed" figure negates it. It reads only
 * the account's own legs, so an index backs it.
 */
export const accountBalanceSubquery: OfAccount<Expr<Counted>> = (type, id) =>
  measureOf(balanceIn(oneAccount(type, id)));

/** Net cash received from the outside world by one account. */
export const externalCashBalanceSubquery: OfAccount<Expr<Counted>> = (
  type,
  id,
) => measureOf(externalCashOf(oneAccount(type, id)));

const billedTotalSubquery = (
  kinds: readonly string[],
  type: string,
  id: AccountId,
): Expr<Counted> => {
  const billed = onAccount("source", type, id);
  const credited = onAccount("dest", type, id);
  return measureOf(
    net(
      billed,
      credited,
      every((leg) => amongConstants(leg.kind, kinds), some(billed, credited)),
    ),
  );
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
export const reservationSubtotalSubquery =
  bindFirst(billedTotalSubquery)(TAXED_SALE_KINDS);

/** Total amount billed to one attendee. Booking fees and later manual charges
 * add to the saved ticket subtotal. Payments, refunds and write-offs do not. */
export const orderTotalSubquery = bindFirst(billedTotalSubquery)([
  ...TAXED_SALE_KINDS,
  KIND.fee,
  MANUAL_ATTENDEE_CHARGE,
]);

/**
 * What an attendee still owes: the negation of their net account balance. The
 * one place the "owed equals negative balance" sign convention lives, so the
 * read column, the settle guard, and the finalize guard cannot drift apart.
 */
export const attendeeOwedSubquery = (id: AccountId): Expr<Counted> =>
  valued(sql`-${accountBalanceSubquery(ATTENDEE, id)}`);
