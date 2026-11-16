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

import {
  ATTENDEE,
  MODIFIER,
  REVENUE,
  WORLD,
  WRITEOFF_TYPE,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { MANUAL_ATTENDEE_CHARGE } from "#accounting/manual-entries.ts";
import {
  amongConstants,
  and,
  type Condition,
  type Counted,
  type Expr,
  equal,
  inQuery,
  literal,
  not,
  type Operand,
  or,
  orZero,
  sum,
  valued,
  when,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
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
type Role = "source" | "dest";

/** Ledger ids are TEXT, so an integer column is CAST to match. */
const asText = (id: AccountId): Expr<string> =>
  valued(sql`CAST(${id} AS TEXT)`);

/** The row has this account type and this account id on its `role` side. */
export const onSide =
  (role: Role, type: Operand<string>, id: Operand<string>): LegTest =>
  (leg) =>
    and(equal(leg[`${role}_type`], type), equal(leg[`${role}_id`], id));

/** The row has the account on its `role` side. The type is a constant of the
 *  code, written into the SQL text. */
export const onAccount = (role: Role, type: string, id: AccountId): LegTest =>
  onSide(role, literal(type), asText(id));

const ofKind =
  (kind: string): LegTest =>
  (leg) =>
    equal(leg.kind, literal(kind));

const inEventGroup =
  (eventGroup: Operand<string>): LegTest =>
  (leg) =>
    equal(leg.event_group, eventGroup);

/** The row passes every test. */
const every =
  (...tests: readonly LegTest[]): LegTest =>
  (leg) =>
    and(...tests.map((test) => test(leg)));

/** The row passes some test. */
const some =
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

/**
 * The signed sum every net-balance read shares. Amounts on rows that pass
 * `adds` add, and amounts on rows that pass `subtracts` subtract. The sum is
 * zero when no row passes. The one home for the sign convention of the ledger
 * in SQL, so no two balance reads can disagree on which side credits.
 */
export const signedSum =
  (adds: LegTest, subtracts: LegTest) =>
  (leg: Leg): Expr<Counted> =>
    orZero(
      sum(
        when<number>(
          [
            [adds(leg), leg.amount],
            [subtracts(leg), valued<number>(sql`-${leg.amount}`)],
          ],
          literal(0),
        ),
      ),
    );

/** A figure of its own: the rows that add, less the rows that subtract. It
 * reads only those rows, so an index backs it. `scope` narrows the rows. */
const signedLegSum = (
  adds: LegTest,
  subtracts: LegTest,
  scope: (leg: Leg) => Condition = () => true,
): Expr<Counted> =>
  ledgerLegs()
    .where((leg) => [scope(leg), some(adds, subtracts)(leg)])
    .aggregate(signedSum(adds, subtracts));

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
    .where((assessment) => equal(assessment.booking_group, eventGroup))
    .values((assessment) => assessment.event_group);
  const correction: LegTest = (leg) =>
    and(
      ofKind(KIND.taxSale)(leg),
      inQuery(leg.event_group, correctedGroups),
      some(credit, debit)(leg),
    );
  return ledgerLegs()
    .where(some(saleLeg(attendeeId, listingId, eventGroup), correction))
    .aggregate(signedSum(credit, debit));
};

/** Recognised income includes signed tax reclassifications and write-offs.
 * Refunds leave that historical earned amount unchanged. */
export const creditsLessWriteoffDebits: OfAccount<Expr<Counted>> = (
  type,
  id,
) => {
  const credited: LegTest = (leg) =>
    and(
      onAccount("dest", type, id)(leg),
      not(
        amongConstants(leg.kind, [KIND.refundTaxSale, KIND.refundTaxModifier]),
      ),
    );
  const writtenOff: LegTest = (leg) =>
    and(
      onAccount("source", type, id)(leg),
      or(
        equal(leg.dest_type, literal(WRITEOFF_TYPE)),
        amongConstants(leg.kind, [KIND.taxSale, KIND.taxModifier]),
      ),
    );
  return signedLegSum(credited, writtenOff);
};

/** A booking order's `modifier` legs, as tests and values over one ledger
 *  row. A surcharge credits the modifier's account, which is the destination
 *  side. A discount debits it, which is the source side. `accountId` reads
 *  whichever side holds the modifier, and `signedAmount` reads the effect on
 *  the price: positive for a surcharge and negative for a discount. */
const surchargeSide: LegTest = (leg) => equal(leg.dest_type, literal(MODIFIER));
const discountSide: LegTest = (leg) =>
  equal(leg.source_type, literal(MODIFIER));

export const modifierLeg = {
  accountId: (leg: Leg): Expr<string> =>
    when<string>([[surchargeSide(leg), leg.dest_id]], leg.source_id),
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
  signedLegSum(onAccount("dest", type, id), onAccount("source", type, id));

/** The row has the outside world on its `role` side. */
const onWorld = (role: Role): LegTest =>
  onSide(role, literal(WORLD.type), literal(WORLD.id));

/** Net cash received from the outside world by one account. Payments into the
 * account add. Refunds and reversals back to the world subtract. Other ledger
 * legs do not represent cash and are ignored. */
export const externalCashBalanceSubquery: OfAccount<Expr<Counted>> = (
  type,
  id,
) =>
  signedLegSum(
    every(onAccount("dest", type, id), onWorld("source")),
    every(onAccount("source", type, id), onWorld("dest")),
  );

const billedTotalSubquery = (
  kinds: readonly string[],
  type: string,
  id: AccountId,
): Expr<Counted> =>
  signedLegSum(
    onAccount("source", type, id),
    onAccount("dest", type, id),
    (leg) => amongConstants(leg.kind, kinds),
  );

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
