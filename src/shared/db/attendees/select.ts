/**
 * Field selection for attendee booking reads. A field's subquery is emitted
 * only when asked for, and `price_paid` alone costs four correlated subqueries
 * per row, so narrow reads are much cheaper than full ones.
 */

/* jscpd:ignore-start */
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  accountPredicate,
  attendeeOwedSubquery,
  saleLegPredicate,
} from "#shared/accounting/projection-sql.ts";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { defineReader } from "#shared/db/read.ts";
import {
  inList,
  inSubquery,
  type WhereClause,
} from "#shared/db/where-clauses.ts";
import type { Attendee } from "#shared/types.ts";
/* jscpd:ignore-end */

/**
 * Refunded is read from the ledger, not a stored column: true when a
 * `refund_cash` leg is sourced from the attendee's account. An unmatched LEFT
 * JOIN row has a NULL id, so the EXISTS is 0 rather than an error.
 */
export const refundedFromLedger = (attendeeIdExpr: string): string =>
  `(SELECT EXISTS(SELECT 1 FROM transfers WHERE kind = '${KIND.refundCash}'` +
  ` AND ${accountPredicate("source", ATTENDEE, attendeeIdExpr)})) AS refunded`;

/**
 * Amount paid for one booking row, read from the ledger and scoped to the row's
 * `ledger_event_group` so an attendee with several orders for one listing gets
 * this booking's leg. One `sale` leg can back several rows (a child folding
 * under several parents), so it is split between them in quantity proportion by
 * row id — the shares telescope to the whole leg, losing no penny. Every
 * expression passed in must be table-qualified, or the correlated subqueries'
 * inner `sibling` alias shadows it. A site has one currency, so amounts sum
 * directly.
 */
export const pricePaidFromLedger = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  eventGroupExpr: string,
  rowIdExpr: string,
): string => {
  const saleTotal = `(SELECT COALESCE(SUM(amount), 0) FROM transfers WHERE ${saleLegPredicate(
    attendeeIdExpr,
    listingIdExpr,
    eventGroupExpr,
  )})`;
  const siblingQty = (idBound: string): string =>
    "(SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling" +
    ` WHERE sibling.attendee_id = ${attendeeIdExpr}` +
    ` AND sibling.listing_id = ${listingIdExpr}` +
    ` AND sibling.ledger_event_group = ${eventGroupExpr}${idBound})`;
  const through = siblingQty(` AND sibling.id <= ${rowIdExpr}`);
  const before = siblingQty(` AND sibling.id < ${rowIdExpr}`);
  // NULLIF avoids dividing by zero when no sibling has quantity; the COALESCE
  // below turns the resulting NULL back into 0.
  const totalQty = `NULLIF(${siblingQty("")}, 0)`;
  return (
    `COALESCE(CAST(${saleTotal} * ${through} / ${totalQty} AS INTEGER)` +
    ` - CAST(${saleTotal} * ${before} / ${totalQty} AS INTEGER), 0) AS price_paid`
  );
};

/** What the attendee still owes, read from the ledger: their account balance,
 *  negated. 0 for a fully paid booking and for one with no legs at all. */
export const remainingBalanceFromLedger = (attendeeIdExpr: string): string =>
  `${attendeeOwedSubquery(attendeeIdExpr)} AS remaining_balance`;

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
const listingIntColumn = (join: AttendeeJoin, name: string): string =>
  join === "left"
    ? `COALESCE(listingAttendee.${name}, 0) as ${name}`
    : `listingAttendee.${name}`;

/** Identity columns plus the cheap per-listing columns every caller reads. */
const coreColumns = (join: AttendeeJoin): string =>
  [
    "attendee.id",
    "attendee.created",
    "attendee.kind",
    "attendee.ticket_token_index",
    "attendee.pii_blob",
    "attendee.status_id",
    "attendee.split_logistics_agents",
    listingIntColumn(join, "listing_id"),
    "SUBSTR(listingAttendee.start_at, 1, 10) as date",
    listingIntColumn(join, "quantity"),
    listingIntColumn(join, "checked_in"),
  ].join(", ");

/** A new field is a compile error here until it declares its SQL. */
const FIELD_SQL: Record<AttendeeField, (join: AttendeeJoin) => string> = {
  attachment_downloads: (join) =>
    listingIntColumn(join, "attachment_downloads"),
  end_date: () => "SUBSTR(listingAttendee.end_at, 1, 10) as end_date",
  package_group_id: (join) => listingIntColumn(join, "package_group_id"),
  price_paid: () =>
    pricePaidFromLedger(
      "listingAttendee.attendee_id",
      "listingAttendee.listing_id",
      "listingAttendee.ledger_event_group",
      "listingAttendee.id",
    ),
  refunded: () => refundedFromLedger("listingAttendee.attendee_id"),
  remaining_balance: () => remainingBalanceFromLedger("attendee.id"),
};

/**
 * The SELECT column list. Use this when the caller runs the query itself, such
 * as inside a `queryBatch`; otherwise reach for {@link getAttendees}.
 */
export const attendeeColumns = (
  join: AttendeeJoin,
  fields: readonly AttendeeField[],
): string =>
  [coreColumns(join), ...fields.map((field) => FIELD_SQL[field](join))].join(
    ", ",
  );

/** Which kinds a read includes. Always a trusted constant, so it is inlined
 *  into the SQL rather than bound as an argument. */
export type AttendeeKindFilter =
  | "attendee"
  | "servicing"
  | "attendee-or-servicing";

const KIND_CLAUSE: Record<AttendeeKindFilter, string> = {
  attendee: `attendee.kind = '${ATTENDEE_KIND}'`,
  "attendee-or-servicing": `attendee.kind IN ('${ATTENDEE_KIND}', '${SERVICING_KIND}')`,
  servicing: `attendee.kind = '${SERVICING_KIND}'`,
};

/**
 * Which attendees a read keeps. Each field present adds one WHERE clause;
 * absent ones don't constrain. `kind` defaults to regular attendees, and every
 * id filter takes an array, so one and many read the same way.
 */
export type AttendeeWhere = {
  kind?: AttendeeKindFilter;
  attendeeIds?: number[];
  /** Attendees this subquery returns — "pick attendees, then return all their
   *  booking lines". It carries its own bound args. */
  attendeeIdsSubquery?: SqlStatement;
  listingIds?: number[];
  /** Booking lines within one package group. */
  packageGroupId?: number;
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

const ORDER_SQL: Record<AttendeeOrder, string> = {
  created_desc: "attendee.created DESC",
  id_asc: "attendee.id ASC, listingAttendee.listing_id ASC",
  id_desc: "attendee.id DESC, listingAttendee.listing_id ASC",
  listing_asc: "listingAttendee.listing_id ASC",
  start_then_listing: "listingAttendee.start_at, listingAttendee.listing_id",
  upcoming: "COALESCE(listingAttendee.start_at, attendee.created), attendee.id",
};

const whereClauses = (where: AttendeeWhere): WhereClause[] => {
  const parts: WhereClause[] = [
    { args: [], clause: KIND_CLAUSE[where.kind ?? "attendee"] },
    ...inList("attendee.id", where.attendeeIds),
  ];
  if (where.attendeeIdsSubquery !== undefined) {
    parts.push(...inSubquery("attendee.id", where.attendeeIdsSubquery));
  }
  parts.push(...inList("listingAttendee.listing_id", where.listingIds));
  if (where.packageGroupId !== undefined) {
    parts.push({
      args: [where.packageGroupId],
      clause: "listingAttendee.package_group_id = ?",
    });
  }
  if (where.realLinesOnly) {
    parts.push({ args: [], clause: "listingAttendee.quantity > 0" });
  }
  if (where.upcomingFrom !== undefined) {
    parts.push({
      args: [where.upcomingFrom],
      clause:
        "(listingAttendee.start_at IS NULL OR DATE(listingAttendee.start_at) >= ?)",
    });
  }
  if (where.dailyRange !== undefined) {
    parts.push({
      args: [where.dailyRange.before, where.dailyRange.after],
      clause:
        "listing.listing_type = 'daily' AND listingAttendee.start_at < ? AND listingAttendee.end_at > ?",
    });
  }
  return parts;
};

/** A daily range is the one filter that also needs the listings table, because
 *  it asks about the listing rather than the booking. */
const attendeeFrom = (join: AttendeeJoin, where: AttendeeWhere): string =>
  `attendees AS attendee ${join === "left" ? "LEFT JOIN" : "JOIN"}` +
  " listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id" +
  (where.dailyRange === undefined
    ? ""
    : " JOIN listings AS listing ON listingAttendee.listing_id = listing.id");

export type GetAttendeesQuery<F extends AttendeeField> = {
  fields: readonly F[];
  where: AttendeeWhere;
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
      columns: attendeeColumns(join, query.fields),
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
