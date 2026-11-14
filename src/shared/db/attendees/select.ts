/**
 * Field selection for attendee booking reads. A field's subquery is emitted
 * only when asked for, and `price_paid` alone emits six correlated subqueries
 * per row, so narrow reads are much cheaper than full ones.
 */

import { ATTENDEE, REVENUE } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import {
  accountPredicate,
  attendeeOwedSubquery,
  bookingSaleTotalSubquery,
  saleLegPredicate,
} from "#accounting/projection-sql.ts";
import { ATTENDEE_KIND, SERVICING_KIND } from "#db/attendees/kind.ts";
import { emailOwedColumn } from "#db/attendees/notification-flags.ts";

import { defineReader } from "#db/read.ts";
import { sql, sqlCommas, sqlLiteral, sqlName, type SqlStatement } from "#db/sql.ts";
import { inList, inSubquery, type WhereClause } from "#db/where-clauses.ts";
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
  attendeeId: SqlStatement;
  eventGroup: SqlStatement;
  listingId: SqlStatement;
  placeholderWhen: SqlStatement;
};

/** The row expressions every read through the `listingAttendee` alias shares. */
export const LISTING_ATTENDEE_REFUNDED_ROW: RefundedRowExprs = {
  attendeeId: sql`listingAttendee.attendee_id`,
  eventGroup: sql`listingAttendee.ledger_event_group`,
  listingId: sql`listingAttendee.listing_id`,
  placeholderWhen: sql`listingAttendee.quantity = 0`,
};

const legCameBack = (predicate: SqlStatement): SqlStatement =>
  sql`EXISTS(SELECT 1 FROM transfers WHERE ${predicate})`;

export const refundedForBooking = (row: RefundedRowExprs): SqlStatement => {
  const { attendeeId, eventGroup, listingId, placeholderWhen } = row;
  const wasSold = legCameBack(
    saleLegPredicate(attendeeId, listingId, eventGroup),
  );
  const saleCameBack = legCameBack(
    sql`kind = ${sqlLiteral(KIND.refundSale)} AND ${accountPredicate(
      "source",
      REVENUE,
      listingId,
    )} AND ${accountPredicate(
      "dest",
      ATTENDEE,
      attendeeId,
    )} AND reverses_group = ${eventGroup}`,
  );
  // A free line has no sale of its own, so it reads the order as a whole:
  // refunded only once the order was reversed AND every sale leg of it came
  // back. A partial reversal must not refund a free package member beside an
  // unreversed line — and a stamped order with no sale legs (a free listing
  // plus a booking fee, or a surcharge) must not read refunded off an empty
  // sale set, so the reversal itself is the positive evidence.
  const orderWasReversed = legCameBack(
    sql`kind GLOB 'refund_*' AND reverses_group = ${eventGroup}`,
  );
  const orderFullyReturned = sql`NOT EXISTS(SELECT 1 FROM transfers AS unreturned WHERE kind = ${sqlLiteral(
    KIND.sale,
  )} AND ${accountPredicate(
    "source",
    ATTENDEE,
    attendeeId,
  )} AND unreturned.dest_type = ${sqlLiteral(
    REVENUE,
  )} AND unreturned.event_group = ${eventGroup} AND NOT EXISTS(SELECT 1 FROM transfers AS returned WHERE returned.kind = ${sqlLiteral(
    KIND.refundSale,
  )} AND ${accountPredicate(
    "source",
    REVENUE,
    sql`unreturned.dest_id`,
  )} AND ${accountPredicate(
    "dest",
    ATTENDEE,
    attendeeId,
  )} AND returned.reverses_group = ${eventGroup}))`;
  const cashCameBack = legCameBack(
    sql`kind = ${sqlLiteral(KIND.refundCash)} AND ${accountPredicate(
      "source",
      ATTENDEE,
      attendeeId,
    )}`,
  );
  const chainFullyReturned = sql`NOT EXISTS(SELECT 1 FROM booking_tax_assessments AS assessment JOIN transfers AS chain ON chain.event_group = assessment.event_group WHERE assessment.booking_group = ${eventGroup} AND chain.kind NOT GLOB 'refund_*' AND NOT EXISTS(SELECT 1 FROM transfers AS returned WHERE returned.kind GLOB 'refund_*' AND returned.reverses_group = chain.event_group AND returned.amount = chain.amount AND returned.source_type = chain.dest_type AND returned.source_id = chain.dest_id AND returned.dest_type = chain.source_type AND returned.dest_id = chain.source_id))`;
  // A row with no recorded order has nothing to reverse into: its group is
  // '' and every leg test after it would match nothing, so never fall through.
  return sql`(SELECT CASE WHEN ${wasSold} THEN ${saleCameBack} AND ${chainFullyReturned} WHEN ${placeholderWhen} THEN ${cashCameBack} WHEN ${eventGroup} = '' THEN 0 ELSE ${orderWasReversed} AND ${orderFullyReturned} AND ${chainFullyReturned} END)`;
};

/** {@link refundedForBooking} under the alias the booking row type reads. */
export const refundedFromLedger = (row: RefundedRowExprs): SqlStatement =>
  sql`${refundedForBooking(row)} AS refunded`;

/**
 * One booking's ticket income, including its tax corrections, split between
 * rows in quantity proportion by row id. The shares telescope to the full
 * amount without losing a penny. Expressions must be table-qualified so the
 * inner `sibling` alias cannot shadow them.
 */
export const pricePaidFromLedger = (
  attendeeIdExpr: SqlStatement,
  listingIdExpr: SqlStatement,
  eventGroupExpr: SqlStatement,
  rowIdExpr: SqlStatement,
): SqlStatement => {
  const saleTotal = bookingSaleTotalSubquery(
    attendeeIdExpr,
    listingIdExpr,
    eventGroupExpr,
  );
  const siblingQty = (idBound: SqlStatement): SqlStatement =>
    sql`(SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling WHERE sibling.attendee_id = ${attendeeIdExpr} AND sibling.listing_id = ${listingIdExpr} AND sibling.ledger_event_group = ${eventGroupExpr}${idBound})`;
  const through = siblingQty(sql` AND sibling.id <= ${rowIdExpr}`);
  const before = siblingQty(sql` AND sibling.id < ${rowIdExpr}`);
  // NULLIF avoids dividing by zero when no sibling has quantity. The COALESCE
  // turns the resulting NULL back into 0.
  const totalQty = sql`NULLIF(${siblingQty(sql``)}, 0)`;
  return sql`COALESCE(CAST(${saleTotal} * ${through} / ${totalQty} AS INTEGER) - CAST(${saleTotal} * ${before} / ${totalQty} AS INTEGER), 0) AS price_paid`;
};

/** What the attendee still owes, read from the ledger: their account balance,
 *  negated. 0 for a fully paid booking and for one with no legs at all. */
export const remainingBalanceFromLedger = (
  attendeeIdExpr: SqlStatement,
): SqlStatement =>
  sql`${attendeeOwedSubquery(attendeeIdExpr)} AS remaining_balance`;

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
  | "package_group_id";

/** Every selectable field. */
export const ATTENDEE_FIELDS = [
  "remaining_balance",
  "refunded",
  "price_paid",
  "end_date",
  "attachment_downloads",
  "package_group_id",
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

/** Identity columns plus the cheap per-listing columns every caller reads. */
const coreColumns = (
  join: AttendeeJoin,
  owedScope: AttendeeOwedScope,
): SqlStatement[] => [
  sql`attendee.id`,
  sql`attendee.created`,
  sql`attendee.kind`,
  sql`attendee.ticket_token_index`,
  sql`attendee.pii_blob`,
  sql`attendee.status_id`,
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
  price_paid: () =>
    pricePaidFromLedger(
      sql`listingAttendee.attendee_id`,
      sql`listingAttendee.listing_id`,
      sql`listingAttendee.ledger_event_group`,
      sql`listingAttendee.id`,
    ),
  refunded: () => refundedFromLedger(LISTING_ATTENDEE_REFUNDED_ROW),
  remaining_balance: () => remainingBalanceFromLedger(sql`attendee.id`),
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

const KIND_CLAUSE: Record<AttendeeKindFilter, SqlStatement> = {
  attendee: sql`attendee.kind = ${sqlLiteral(ATTENDEE_KIND)}`,
  "attendee-or-servicing": sql`attendee.kind IN (${sqlLiteral(
    ATTENDEE_KIND,
  )}, ${sqlLiteral(SERVICING_KIND)})`,
  servicing: sql`attendee.kind = ${sqlLiteral(SERVICING_KIND)}`,
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

const whereClauses = (where: AttendeeWhere): WhereClause[] => {
  const parts: WhereClause[] = [
    { clause: KIND_CLAUSE[where.kind ?? "attendee"] },
    ...inList("attendee.id", where.attendeeIds),
  ];
  if (where.attendeeIdsSubquery !== undefined) {
    parts.push(...inSubquery("attendee.id", where.attendeeIdsSubquery));
  }
  parts.push(...inList("listingAttendee.listing_id", where.listingIds));
  if (where.realLinesOnly) {
    parts.push({ clause: sql`listingAttendee.quantity > 0` });
  }
  if (where.upcomingFrom !== undefined) {
    parts.push({
      clause: sql`(listingAttendee.start_at IS NULL OR DATE(listingAttendee.start_at) >= ${where.upcomingFrom})`,
    });
  }
  if (where.dailyRange !== undefined) {
    parts.push({
      clause: sql`listing.listing_type = 'daily' AND listingAttendee.start_at < ${where.dailyRange.before} AND listingAttendee.end_at > ${where.dailyRange.after}`,
    });
  }
  return parts;
};

const BOOKING_JOIN: Record<AttendeeJoin, SqlStatement> = {
  inner: sql`JOIN`,
  left: sql`LEFT JOIN`,
};

/** A daily range is the one filter that also needs the listings table, because
 *  it asks about the listing rather than the booking. */
const attendeeFrom = (join: AttendeeJoin, where: AttendeeWhere): SqlStatement =>
  sql`attendees AS attendee ${BOOKING_JOIN[join]} listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id${
    where.dailyRange === undefined
      ? sql``
      : sql` JOIN listings AS listing ON listingAttendee.listing_id = listing.id`
  }`;

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
const attendees = defineReader<AttendeeOrder, GetAttendeesQuery<AttendeeField>>(
  ORDER_SQL,
  (query) => {
    const join = query.join ?? "inner";
    return {
      columns: attendeeColumns(
        join,
        query.fields,
        query.owedScope ?? "attendee",
      ),
      from: attendeeFrom(join, query.where),
      where: whereClauses(query.where),
    };
  },
);

/**
 * SQL and bound args for a read, for callers that want it inside a batch — such
 * as pairing a listing read with an attendee read in one round-trip.
 */
export const attendeeBatchStatement = <F extends AttendeeField>(
  query: GetAttendeesQuery<F>,
): SqlStatement => attendees.statement(query);

/** Runs the read and returns raw rows typed to exactly the fields asked for. */
export const getAttendees = <F extends AttendeeField>(
  query: GetAttendeesQuery<F>,
): Promise<AttendeeRowFor<F>[]> => attendees.rows<AttendeeRowFor<F>>(query);
