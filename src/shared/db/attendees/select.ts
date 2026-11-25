/**
 * Field selection for attendee booking reads. A field's subquery is emitted
 * only when asked for, and `price_paid` alone emits six correlated subqueries
 * per row, so narrow reads are much cheaper than full ones.
 */

import { ATTENDEE, REVENUE } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import {
  type AccountId,
  attendeeOwedSubquery,
  bookingSaleTotalSubquery,
  type Leg,
  type LegTest,
  ledgerLegs,
  onAccount,
  saleLeg,
} from "#accounting/projection-sql.ts";
import { ATTENDEE_KIND, SERVICING_KIND } from "#db/attendees/kind.ts";
import { emailOwedColumn } from "#db/attendees/notification-flags.ts";
import { readRows } from "#db/read.ts";
import {
  among,
  amongConstants,
  and,
  atMost,
  type Condition,
  type Expr,
  equal,
  given,
  greaterThan,
  inStatement,
  lessThan,
  literal,
  matchesGlob,
  not,
  orZero,
  sum,
  when,
  wholeCondition,
} from "#db/select/expression.ts";
import { from, tableNode } from "#db/select/query.ts";
import type { Node, Query } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlCommas, sqlName } from "#db/sql.ts";
import type { Attendee } from "#types";

/**
 * Projected from the ledger rather than a stored column, so the projection and
 * the stats that exclude refunded bookings cannot answer differently.
 *
 * Asked per BOOKING ORDER — the row's `ledger_event_group` — not per person,
 * because one person can hold two orders for the same listing (a merge), and
 * reversing one must not mark the other refunded: the scanner turns people
 * away on this flag. A reversal leg carries the order it undid in
 * `reverses_group`, which is what makes the join answerable in SQL.
 */
/** What one booking row tells the refunded projection, as SQL expressions:
 *  who booked, on which listing, in which order, and when the row is a
 *  quantity-0 placeholder. */
export type RefundedRowExprs = {
  attendeeId: Expr<number>;
  eventGroup: Expr<string>;
  listingId: Expr<number>;
  placeholderWhen: Condition;
};

/** One booking row, as a statement reads it. */
export type BookingRow = Node<"listing_attendees">;

/** The booking row of a statement that names the table
 *  `listing_attendees AS <word>`. */
export const bookingRow = (word: string): BookingRow =>
  tableNode(tables.listing_attendees, word);

export const BOOKING_ROW = bookingRow("listingAttendee");

/** What a booking row tells the refunded projection. */
export const refundedRowOf = (row: BookingRow): RefundedRowExprs => ({
  attendeeId: row.attendeeId,
  eventGroup: row.ledgerEventGroup,
  listingId: row.listingId,
  placeholderWhen: equal(row.quantity, literal(0)),
});

/** Each side of a refund leg, and the side of the leg it gives back: the
 *  money returns along the same accounts. */
const MIRRORED_SIDES = [
  ["sourceType", "destType"],
  ["sourceId", "destId"],
  ["destType", "sourceType"],
  ["destId", "sourceId"],
] as const;

const legExists = (test: LegTest): Expr<boolean> =>
  ledgerLegs().where(test).exists();

const isRefund = (leg: Leg): Expr<boolean> => matchesGlob(leg.kind, "refund_*");

export const refundedForBooking = (row: RefundedRowExprs): Expr<boolean> => {
  const { attendeeId, eventGroup, listingId, placeholderWhen } = row;
  const wasSold = legExists(saleLeg(attendeeId, listingId, eventGroup));
  /** The leg that gives the sale of one listing back to the attendee. */
  const saleRefund =
    (listing: AccountId): LegTest =>
    (leg) =>
      and(
        equal(leg.kind, literal(KIND.refundSale)),
        onAccount("source", REVENUE, listing)(leg),
        onAccount("dest", ATTENDEE, attendeeId)(leg),
        equal(leg.reversesGroup, eventGroup),
      );
  const saleCameBack = legExists(saleRefund(listingId));
  // A free line has no sale of its own, so it reads the order as a whole:
  // refunded only once the order was reversed AND every sale leg of it came
  // back. A partial reversal must not refund a free package member beside an
  // unreversed line — and a stamped order with no sale legs (a free listing
  // plus a booking fee, or a surcharge) must not read refunded off an empty
  // sale set, so the reversal itself is the positive evidence.
  const orderWasReversed = legExists((leg) =>
    and(isRefund(leg), equal(leg.reversesGroup, eventGroup)),
  );
  const unreturnedSale = ledgerLegs()
    .as("unreturned")
    .where((sale) => [
      equal(sale.kind, literal(KIND.sale)),
      onAccount("source", ATTENDEE, attendeeId)(sale),
      equal(sale.destType, literal(REVENUE)),
      equal(sale.eventGroup, eventGroup),
      not(ledgerLegs().as("returned").where(saleRefund(sale.destId)).exists()),
    ]);
  const orderFullyReturned = not(unreturnedSale.exists());
  const cashCameBack = legExists((leg) =>
    and(
      equal(leg.kind, literal(KIND.refundCash)),
      onAccount("source", ATTENDEE, attendeeId)(leg),
    ),
  );
  const unreturnedChainLeg = from(tables.booking_tax_assessments)
    .join("chain", tables.transfers, (assessment) =>
      equal(assessment.chain.eventGroup, assessment.eventGroup),
    )
    .where((assessment) => [
      equal(assessment.bookingGroup, eventGroup),
      not(isRefund(assessment.chain)),
      not(
        ledgerLegs()
          .as("returned")
          .where((refund) => [
            isRefund(refund),
            equal(refund.reversesGroup, assessment.chain.eventGroup),
            equal(refund.amount, assessment.chain.amount),
            ...MIRRORED_SIDES.map(([back, out]) =>
              equal(refund[back], assessment.chain[out]),
            ),
          ])
          .exists(),
      ),
    ]);
  const chainFullyReturned = not(unreturnedChainLeg.exists());
  // A row with no recorded order has nothing to reverse into: its group is
  // '' and every leg test after it would match nothing, so never fall through.
  const refunded = when<boolean>(
    [
      [wasSold, and(saleCameBack, chainFullyReturned)],
      [placeholderWhen, cashCameBack],
      [equal(eventGroup, literal("")), and(false)],
    ],
    and(orderWasReversed, orderFullyReturned, chainFullyReturned),
  );
  return wholeCondition(sql`(SELECT ${refunded})`);
};

/** {@link refundedForBooking} under the alias the booking row type reads. */
export const refundedFromLedger = (row: RefundedRowExprs): SqlStatement =>
  sql`${refundedForBooking(row)} AS refunded`;

/**
 * One booking's ticket income, including its tax corrections, split between
 * rows in quantity proportion by row id. The shares telescope to the full
 * amount without losing a penny.
 */
export const pricePaidFromLedger = (row: BookingRow): SqlStatement => {
  const attendeeId = row.attendeeId;
  const listingId = row.listingId;
  const eventGroup = row.ledgerEventGroup;
  const rowId = row.id;
  const saleTotal = bookingSaleTotalSubquery(attendeeId, listingId, eventGroup);
  const siblingQuantity = (
    upTo: (sibling: Node<"listing_attendees">) => Condition,
  ) =>
    from(tables.listing_attendees)
      .as("sibling")
      .where((sibling) => [
        equal(sibling.attendeeId, attendeeId),
        equal(sibling.listingId, listingId),
        equal(sibling.ledgerEventGroup, eventGroup),
        upTo(sibling),
      ])
      .aggregate((sibling) => orZero(sum(sibling.quantity)));
  const through = siblingQuantity((sibling) => atMost(sibling.id, rowId));
  const before = siblingQuantity((sibling) => lessThan(sibling.id, rowId));
  // NULLIF avoids dividing by zero when no sibling has quantity. The COALESCE
  // turns the resulting NULL back into 0.
  const totalQty = sql`NULLIF(${siblingQuantity(() => true)}, 0)`;
  return sql`COALESCE(CAST(${saleTotal} * ${through} / ${totalQty} AS INTEGER) - CAST(${saleTotal} * ${before} / ${totalQty} AS INTEGER), 0) AS price_paid`;
};

/** What the attendee still owes, read from the ledger: their account balance,
 *  negated. 0 for a fully paid booking and for one with no legs at all. */
export const remainingBalanceFromLedger = (
  attendeeId: AccountId,
): SqlStatement =>
  sql`${attendeeOwedSubquery(attendeeId)} AS remaining_balance`;

/** Callers MUST pass the join their own FROM clause uses: `left` COALESCEs the
 *  per-listing columns so an attendee with no booking row reads zeros. */
export type AttendeeJoin = "inner" | "left";

/**
 * The fields a caller can opt into. The first three are ledger subqueries, the
 * rest cheap columns; anything not listed here is always emitted.
 */
export type AttendeeField =
  | "remaining_balance"
  | "refunded"
  | "price_paid"
  | "end_date"
  | "attachment_downloads"
  | "package_group_id"
  | "parent_listing_id";

/** Every selectable field. */
export const ATTENDEE_FIELDS = [
  "remaining_balance",
  "refunded",
  "price_paid",
  "end_date",
  "attachment_downloads",
  "package_group_id",
  "parent_listing_id",
] as const satisfies readonly AttendeeField[];

/**
 * The row shape for a chosen field set. These are raw rows: PII is still
 * encrypted, so decrypt with `decryptAttendees` before displaying anything.
 */
export type AttendeeRowFor<F extends AttendeeField = never> = Omit<
  Attendee,
  AttendeeField
> &
  Pick<Attendee, F>;

/** A per-listing integer column, 0 rather than NULL under a LEFT join. */
const listingIntColumn = (join: AttendeeJoin, name: string): SqlStatement => {
  const column = sqlName(`listingAttendee.${name}`);
  return join === "left"
    ? sql`COALESCE(${column}, 0) as ${sqlName(name)}`
    : column;
};

/** Whose booking a read's `email_owed` asks about. `booking` scopes the rule
 * to the row's own listing: the row is one booking, so the badge shows only
 * what that booking owes. `attendee` keeps the rule attendee-wide: the badge
 * says what any of the person's bookings owes. */
export type AttendeeOwedScope = "attendee" | "booking";

/** The attendee row of a statement that names the table
 *  `attendees AS attendee`. */
export const ATTENDEE_ROW = tableNode(tables.attendees, "attendee");

/** The columns that identify an attendee in every read of the table. */
export const ATTENDEE_IDENTITY_COLUMNS: readonly SqlStatement[] = [
  sql`attendee.id`,
  sql`attendee.created`,
  sql`attendee.kind`,
  sql`attendee.ticket_token_index`,
  sql`attendee.pii_blob`,
  sql`attendee.status_id`,
];

/** Identity columns plus the cheap per-listing columns every caller reads. */
const coreColumns = (
  join: AttendeeJoin,
  owedScope: AttendeeOwedScope,
): SqlStatement[] => [
  ...ATTENDEE_IDENTITY_COLUMNS,
  sql`attendee.split_logistics_agents`,
  sql`attendee.email_pending`,
  sql`attendee.webhooks_pending`,
  emailOwedColumn(
    "attendee",
    owedScope === "booking" ? sql`listingAttendee.listing_id` : undefined,
  ),
  listingIntColumn(join, "listing_id"),
  sql`SUBSTR(listingAttendee.start_at, 1, 10) as date`,
  listingIntColumn(join, "quantity"),
  listingIntColumn(join, "checked_in"),
];

/** A new field is a compile error here until it declares its SQL. */
const FIELD_SQL: Record<AttendeeField, (join: AttendeeJoin) => SqlStatement> = {
  attachment_downloads: (join) =>
    listingIntColumn(join, "attachment_downloads"),
  end_date: () => sql`SUBSTR(listingAttendee.end_at, 1, 10) as end_date`,
  package_group_id: (join) => listingIntColumn(join, "package_group_id"),
  parent_listing_id: (join) => listingIntColumn(join, "parent_listing_id"),
  price_paid: () => pricePaidFromLedger(BOOKING_ROW),
  refunded: () => refundedFromLedger(refundedRowOf(BOOKING_ROW)),
  remaining_balance: () => remainingBalanceFromLedger(ATTENDEE_ROW.id),
};

/**
 * The SELECT column list. Use this when the caller runs the query itself, such
 * as inside a `queryBatch`; otherwise reach for {@link getAttendees}.
 */
export const attendeeColumns = (
  join: AttendeeJoin,
  fields: readonly AttendeeField[],
  owedScope: AttendeeOwedScope,
): SqlStatement =>
  sqlCommas([
    ...coreColumns(join, owedScope),
    ...fields.map((field) => FIELD_SQL[field](join)),
  ]);

/** Which kinds a read includes. Always a trusted constant, so it is inlined
 *  into the SQL rather than bound as an argument. */
export type AttendeeKindFilter =
  | "attendee"
  | "servicing"
  | "attendee-or-servicing";

const KIND_CONDITION: Record<AttendeeKindFilter, Expr<boolean>> = {
  attendee: equal(ATTENDEE_ROW.kind, literal(ATTENDEE_KIND)),
  "attendee-or-servicing": amongConstants(ATTENDEE_ROW.kind, [
    ATTENDEE_KIND,
    SERVICING_KIND,
  ]),
  servicing: equal(ATTENDEE_ROW.kind, literal(SERVICING_KIND)),
};

/**
 * Which attendees a read keeps. Each field present adds one WHERE clause;
 * absent ones don't constrain. `kind` defaults to regular attendees.
 * `attendeeIds` and `listingIds` take arrays, so one and many read the same way.
 */
export type AttendeeWhere = {
  kind?: AttendeeKindFilter;
  attendeeIds?: number[];
  /** Attendees this subquery returns — "pick attendees, then return all their
   *  booking lines". It carries its own bound args. */
  attendeeIdsSubquery?: SqlStatement;
  listingIds?: number[];
  /** Drop no-quantity sentinel lines (`quantity > 0`). */
  realLinesOnly?: boolean;
  /** Keep lines starting on/after this `YYYY-MM-DD`, or with no start date. */
  upcomingFrom?: string;
  /** Daily-listing lines overlapping `[after, before)`, `before` exclusive. */
  dailyRange?: { after: string; before: string };
};

/** Named orders, so a caller cannot hand-roll a stray `ORDER BY`. */
export type AttendeeOrder =
  | "created_desc"
  | "id_desc"
  | "id_asc"
  | "listing_asc"
  | "start_then_listing"
  | "upcoming";

const ORDER_SQL: Record<AttendeeOrder, SqlStatement> = {
  created_desc: sql`attendee.created DESC`,
  id_asc: sql`attendee.id ASC, listingAttendee.listing_id ASC`,
  id_desc: sql`attendee.id DESC, listingAttendee.listing_id ASC`,
  listing_asc: sql`listingAttendee.listing_id ASC`,
  start_then_listing: sql`listingAttendee.start_at, listingAttendee.listing_id`,
  upcoming: sql`COALESCE(listingAttendee.start_at, attendee.created), attendee.id`,
};

/** The listing row of a daily range read. */
const LISTING_ROW = tableNode(tables.listings, "listing");

const whereConditions = (where: AttendeeWhere): Condition[] => [
  KIND_CONDITION[where.kind ?? "attendee"],
  given(where.attendeeIds, (ids) => among(ATTENDEE_ROW.id, ids)),
  given(where.attendeeIdsSubquery, (chosen) =>
    inStatement(ATTENDEE_ROW.id, chosen),
  ),
  given(where.listingIds, (ids) => among(BOOKING_ROW.listingId, ids)),
  where.realLinesOnly ? greaterThan(BOOKING_ROW.quantity, literal(0)) : true,
  given(where.upcomingFrom, (day) =>
    wholeCondition(
      sql`(${BOOKING_ROW.startAt} IS NULL OR DATE(${BOOKING_ROW.startAt}) >= ${day})`,
    ),
  ),
  given(where.dailyRange, ({ after, before }) =>
    and(
      equal(LISTING_ROW.listingType, literal("daily")),
      lessThan(BOOKING_ROW.startAt, before),
      greaterThan(BOOKING_ROW.endAt, after),
    ),
  ),
];

/** The attendees with their booking rows. A daily range is the one filter
 *  that also needs the listings table, because it asks about the listing
 *  and not about the booking. */
const attendeesWithBookings = (
  join: AttendeeJoin,
  where: AttendeeWhere,
): Query<unknown, never> => {
  const everyAttendee = from(tables.attendees);
  const withLines =
    join === "left" ? everyAttendee.leftJoin : everyAttendee.join;
  const booked: Query<unknown, never> = withLines(
    "listingAttendee",
    tables.listing_attendees,
    (attendee) => equal(attendee.listingAttendee.attendeeId, attendee.id),
  );
  return where.dailyRange === undefined
    ? booked
    : booked.join("listing", tables.listings, (row) =>
        equal(BOOKING_ROW.listingId, row.listing.id),
      );
};

export type GetAttendeesQuery<F extends AttendeeField> = {
  fields: readonly F[];
  where: AttendeeWhere;
  /** Whose booking the read's `email_owed` asks about. It defaults to the
   *  attendee-wide rule, the reach the read always had. A read whose rows
   *  stand for one booking — a roster row — must opt in with `booking`.
   *  That row's badge then asks about its own booking's listing alone.
   *  The grouped person rows keep the default. */
  owedScope?: AttendeeOwedScope;
  /** Omit only for a single-row read; a list read always passes one, so its
   *  rows come back the same way every time. */
  order?: AttendeeOrder;
  /** Defaults to INNER. Use `left` to keep an attendee whose booking linkage is
   *  missing, which reads as a single `listing_id = 0` row. */
  join?: AttendeeJoin;
};
const attendeeStatement = (
  query: GetAttendeesQuery<AttendeeField>,
): SqlStatement => {
  const join = query.join ?? "inner";
  return attendeesWithBookings(join, query.where)
    .where(() => whereConditions(query.where))
    .orderBy(() => (query.order === undefined ? [] : [ORDER_SQL[query.order]]))
    .columns(() =>
      attendeeColumns(join, query.fields, query.owedScope ?? "attendee"),
    );
};

/**
 * SQL and bound args for a read, for callers that want it inside a batch — such
 * as pairing a listing read with an attendee read in one round-trip.
 */
export const attendeeBatchStatement = <F extends AttendeeField>(
  query: GetAttendeesQuery<F>,
): SqlStatement => attendeeStatement(query);

/** Runs the read and returns raw rows typed to exactly the fields asked for. */
export const getAttendees = <F extends AttendeeField>(
  query: GetAttendeesQuery<F>,
): Promise<AttendeeRowFor<F>[]> =>
  readRows<AttendeeRowFor<F>>(attendeeStatement(query));
