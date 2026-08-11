/**
 * Field-selection interface for reading attendee booking rows.
 *
 * Each caller declares exactly which projected fields it needs. The builder
 * always emits the cheap identity and per-listing columns, and adds an
 * expensive field's subquery only when it is asked for — `price_paid` alone
 * costs four correlated subqueries per row — so a table showing just quantity
 * and check-in state runs none of the money subqueries. Passing
 * {@link ATTENDEE_FIELDS} asks for every field.
 *
 * The three ledger-subquery fragments live here because this is where the
 * attendee projection is assembled; `queries.ts`, `tokens.ts` and `balance.ts`
 * import them for their own narrower projections.
 */

/* jscpd:ignore-start */
import { ATTENDEE, REVENUE } from "#shared/accounting/accounts.ts";
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
 * This booking's refund status as a bare SQL expression (0/1), projected from
 * the transfers ledger rather than a stored column. The single home for "did
 * THIS booking come back", so the projection and the stats that exclude
 * refunded bookings cannot answer it differently.
 *
 * Asked per LISTING, not per person: a refund can now return one of somebody's
 * charges and leave a sibling with the provider, and the scanner and check-in
 * both turn people away on this flag. "Any `refund_cash` sourced from them"
 * would refuse a ticket they had paid for and not got back.
 *
 * A refund mirrors every leg of the order it reverses, so a sold booking that
 * came back has a `refund_sale` running the other way — revenue to attendee.
 * That is the precise question, and it holds for backfilled historical refunds
 * too, since they are mapped by the same reverser.
 *
 * A payment-only placeholder has no sale to mirror, so it falls back to the
 * account's returned cash. Only a placeholder may: a FREE booking has no sale
 * leg either, and reading the account's cash there would turn a real ticket
 * away because some other booking of theirs came back. Anything else with no
 * sale of its own took no money and so cannot have had any returned.
 */
export const refundedForBooking = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  placeholderWhen: string,
): string => {
  const legExists = (kind: string, predicate: string): string =>
    `EXISTS(SELECT 1 FROM transfers WHERE kind = '${kind}' AND ${predicate})`;
  const wasSold = legExists(
    KIND.sale,
    `${accountPredicate("source", ATTENDEE, attendeeIdExpr)} AND ${accountPredicate("dest", REVENUE, listingIdExpr)}`,
  );
  const saleCameBack = legExists(
    KIND.refundSale,
    `${accountPredicate("source", REVENUE, listingIdExpr)} AND ${accountPredicate("dest", ATTENDEE, attendeeIdExpr)}`,
  );
  const cashCameBack = legExists(
    KIND.refundCash,
    accountPredicate("source", ATTENDEE, attendeeIdExpr),
  );
  return (
    `(SELECT CASE WHEN ${wasSold} THEN ${saleCameBack}` +
    ` WHEN ${placeholderWhen} THEN ${cashCameBack} ELSE 0 END)`
  );
};

/** {@link refundedForBooking} under the alias the booking row type reads. */
export const refundedFromLedger = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  placeholderWhen: string,
): string =>
  `${refundedForBooking(attendeeIdExpr, listingIdExpr, placeholderWhen)} AS refunded`;

/**
 * Per-row amount paid, projected from the ledger rather than a stored column:
 * the gross `sale` leg this row recognised, within its stored
 * `ledger_event_group`, so an attendee holding several orders for one listing
 * resolves to exactly this booking's leg. A site has one currency, so amounts
 * sum directly. It stays put after a refund, the reversal being a separate
 * `refund_*` leg, and is 0 when there is no sale leg — a free booking, or an
 * unmatched LEFT JOIN row.
 *
 * A `sale` leg is posted once per listing, but a child folding under several
 * parents turns one order into several rows sharing that single leg. Crediting
 * the whole leg to each would double-count it, so it is split across them in
 * quantity proportion, deterministically by row id: `floor(total *
 * qtyThroughThisRow / totalQty) − floor(total * qtyBeforeThisRow / totalQty)`.
 * The shares telescope to the full leg with no penny lost, and collapse to the
 * whole leg for the ordinary single-row case. All four expressions must be
 * qualified, as they seed correlated subqueries whose inner `sibling` alias
 * would otherwise shadow a bare column. A listing booked through two paths
 * priced differently is averaged, the leg carrying no per-path key.
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
  // NULLIF guards the divide when no sibling has quantity (a lone no-quantity
  // sentinel, or an unmatched LEFT JOIN row); COALESCE then floors the NULL that
  // divide yields back to 0 so `price_paid` is always a number.
  const totalQty = `NULLIF(${siblingQty("")}, 0)`;
  return (
    `COALESCE(CAST(${saleTotal} * ${through} / ${totalQty} AS INTEGER)` +
    ` - CAST(${saleTotal} * ${before} / ${totalQty} AS INTEGER), 0) AS price_paid`
  );
};

/**
 * An attendee's outstanding balance, projected from the ledger instead of a
 * stored column: the negated account balance — what they still owe is the money
 * they were billed (sale legs sourced from them) minus the cash received
 * (deposit and balance-payment legs into them), with a refund's reversal legs
 * netting back out. 0 for a fully-paid booking (every production attendee) and
 * for an attendee with no legs. `attendeeIdExpr` is the attendee id in the
 * surrounding query.
 */
export const remainingBalanceFromLedger = (attendeeIdExpr: string): string =>
  `${attendeeOwedSubquery(attendeeIdExpr)} AS remaining_balance`;

/** Whether the surrounding query joins `listing_attendees` with an INNER or a
 * LEFT join. Under a LEFT join the cheap per-listing columns are COALESCEd so an
 * attendee with no matching booking row still reads sensible zeros. Callers MUST
 * pass the mode that matches their own FROM clause. */
export type AttendeeJoin = "inner" | "left";

/**
 * The projected fields a caller can opt into on top of the always-present core.
 * The first three are correlated ledger subqueries (expensive — `price_paid` is
 * four subqueries); the last three are cheap per-listing columns that most
 * table reads don't need. Everything not listed here (identity columns plus
 * `listing_id`, `date`, `quantity`, `checked_in`) is always emitted.
 */
export type AttendeeField =
  | "remaining_balance"
  | "refunded"
  | "price_paid"
  | "end_date"
  | "attachment_downloads"
  | "package_group_id";

/** Every selectable field — pass this to reproduce the old full projection. */
export const ATTENDEE_FIELDS = [
  "remaining_balance",
  "refunded",
  "price_paid",
  "end_date",
  "attachment_downloads",
  "package_group_id",
] as const satisfies readonly AttendeeField[];

/**
 * A row shape for a chosen field set: the full {@link Attendee} minus every
 * opt-in field, plus back exactly the ones selected. `AttendeeRowFor<never>`
 * (an empty field set) is the leanest money-free row; `AttendeeRowFor<
 * AttendeeField>` is the full `Attendee`. As with the old projections these are
 * raw rows — PII columns are still encrypted; decrypt with `decryptAttendees`.
 */
export type AttendeeRowFor<F extends AttendeeField = never> = Omit<
  Attendee,
  AttendeeField
> &
  Pick<Attendee, F>;

/** A cheap per-listing integer column, COALESCEd to 0 under a LEFT join so an
 * unmatched row reads 0 rather than NULL. */
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

/** Exhaustive map from each opt-in field to the SQL fragment that projects it.
 * A new field is a compile error here until it declares its fragment. */
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
  refunded: () =>
    refundedFromLedger(
      "listingAttendee.attendee_id",
      "listingAttendee.listing_id",
      "listingAttendee.quantity = 0",
    ),
  remaining_balance: () => remainingBalanceFromLedger("attendee.id"),
};

/**
 * The SELECT column list for an attendee read: the core columns plus one
 * fragment per requested field. Use this directly when the caller runs the
 * query itself (e.g. inside a `queryBatch`); otherwise reach for
 * {@link selectAttendees} / {@link selectAttendeeOrNull}.
 */
export const attendeeColumns = (
  join: AttendeeJoin,
  fields: readonly AttendeeField[],
): string =>
  [coreColumns(join), ...fields.map((field) => FIELD_SQL[field](join))].join(
    ", ",
  );

// ---------------------------------------------------------------------------
// getAttendees — one declarative reader for every place that lists attendees
// ---------------------------------------------------------------------------

/** Which kinds of attendee a read includes. `kind` is always a trusted
 * constant, so it is inlined rather than bound. */
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
 * A declarative filter for an attendee read. Each present field adds one WHERE
 * clause (absent fields don't constrain), so a caller says WHICH attendees it
 * wants rather than hand-writing SQL. `kind` defaults to regular attendees.
 */
export type AttendeeWhere = {
  kind?: AttendeeKindFilter;
  /** Attendees by id. A single attendee is a one-element array — there is no
   * separate `= ?` path, so one and many read the same way. */
  attendeeIds?: number[];
  /** Attendees whose id is returned by this subquery — the "pick attendees,
   * then return all their booking lines" pattern (newest N, one page). The
   * subquery carries its own bound args. */
  attendeeIdsSubquery?: SqlStatement;
  /** Booking lines on these listings. A single listing is a one-element array. */
  listingIds?: number[];
  /** Booking lines within one package group. */
  packageGroupId?: number;
  /** Drop no-quantity sentinel lines (`quantity > 0`). */
  realLinesOnly?: boolean;
  /** Keep lines starting on/after this `YYYY-MM-DD`, or with no start date. */
  upcomingFrom?: string;
  /** Restrict to daily-listing lines overlapping `[after, before)` — adds the
   * `listings` join and the `listing_type = 'daily'` guard. `before` is the
   * range's exclusive end, `after` its start. */
  dailyRange?: { after: string; before: string };
};

/** How the rows come back. Named orders so callers can't hand-roll a stray
 * `ORDER BY`; each pairs with the reads that used it. */
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

/**
 * The tables an attendee read starts from. A daily-range filter is the one
 * filter that also needs the listings table, because it asks about the listing
 * rather than the booking.
 */
const attendeeFrom = (join: AttendeeJoin, where: AttendeeWhere): string =>
  `attendees AS attendee ${join === "left" ? "LEFT JOIN" : "JOIN"}` +
  " listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id" +
  (where.dailyRange === undefined
    ? ""
    : " JOIN listings AS listing ON listingAttendee.listing_id = listing.id");

/** Everything a caller declares to list attendees: which fields to project,
 * which rows to keep, in what order, over which join. */
export type GetAttendeesQuery<F extends AttendeeField> = {
  fields: readonly F[];
  where: AttendeeWhere;
  /** Row order. Omit only for a single-row {@link getAttendeeOrNull} read. */
  order?: AttendeeOrder;
  /** Defaults to an INNER join; use `"left"` to keep an attendee whose booking
   * linkage is missing (a single COALESCEd `listing_id = 0` row). */
  join?: AttendeeJoin;
};

/** The attendee reader: the chosen fields, the tables, the filter, the order.
 * A single-attendee read passes no order; a list read always passes one so its
 * rows come back the same way every time. */
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
 * A `queryBatch` statement (SQL + bound args) for an attendee read: the single
 * place a declared query becomes runnable SQL. {@link getAttendees} runs it; the
 * batch readers (which pair a listing read with an attendee read in one
 * round-trip) embed it in a batch instead. Defaults the join, builds the
 * FROM/WHERE/ORDER tail, and prefixes the field-selected column list.
 */
export const attendeeBatchStatement = <F extends AttendeeField>(
  query: GetAttendeesQuery<F>,
): SqlStatement => attendees.statement(query);

/**
 * The one reader every attendee-listing surface uses: declare the fields, the
 * filter and the order, and it emits the minimal query and returns raw rows
 * typed to exactly the requested fields. PII stays encrypted — decrypt before
 * display.
 */
export const getAttendees = <F extends AttendeeField>(
  query: GetAttendeesQuery<F>,
): Promise<AttendeeRowFor<F>[]> => attendees.rows<AttendeeRowFor<F>>(query);
