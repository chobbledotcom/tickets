/** Pure predicates and SQL expressions for the listing count aggregates. */

import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { type SqlStatement, sql, sqlLiteral } from "#db/sql.ts";

/**
 * The listing_attendees columns that shift the listing count aggregates
 * (booked_quantity, tickets_count). The UPDATE trigger fires on exactly these
 * columns; the cache-invalidation gate in listings/records.ts reads the same constant so
 * the two cannot drift. price_paid is no longer here — income is projected from
 * the transfers ledger at read time, not maintained from this column.
 */
export const LISTING_AGGREGATE_WRITE_COLUMNS = [
  "quantity",
  "listing_id",
] as const;

/**
 * A quantity = 0 line is the "no quantity" sentinel. It keeps the
 * attendee↔listing link but is not a ticket, so tickets_count counts only
 * quantity > 0. booked_quantity already treats 0 correctly and must NOT use
 * this predicate.
 *
 * Every site that computes tickets_count references this one constant, so the
 * rule cannot silently diverge. A guard test asserts it appears at every one.
 */
export const TICKET_COUNTS_PREDICATE = sql`quantity > 0 AND kind = ${sqlLiteral(ATTENDEE_KIND)}`;

/** Predicate wrapper for contexts that have a listing_attendees row but need
 * the attendee kind. Missing attendee rows are treated as legacy attendee rows
 * so raw trigger tests and old FK-less data keep their historical ticket count. */
export const ticketCountPredicateFor = (
  quantityExpr: SqlStatement,
  attendeeIdExpr: SqlStatement,
): SqlStatement =>
  sql`EXISTS (SELECT 1 FROM (SELECT ${quantityExpr} AS quantity, CASE WHEN EXISTS (SELECT 1 FROM attendees AS attendee WHERE attendee.id = ${attendeeIdExpr}) THEN (SELECT attendee.kind FROM attendees AS attendee WHERE attendee.id = ${attendeeIdExpr}) ELSE ${sqlLiteral(ATTENDEE_KIND)} END AS kind) WHERE ${TICKET_COUNTS_PREDICATE})`;

/**
 * tickets_count as a COALESCE(SUM(CASE …)) over {@link TICKET_COUNTS_PREDICATE},
 * for the recalculation/restore SELECTs that compute it in one pass alongside
 * SUM(quantity). COALESCE because SUM over zero rows is NULL (unlike COUNT(*)'s
 * 0), so an empty listing would otherwise report bogus drift against a stored 0.
 */
export const ticketCountSumExpr = (): SqlStatement =>
  sql`COALESCE(SUM(CASE WHEN ${ticketCountPredicateFor(
    sql`quantity`,
    sql`attendee_id`,
  )} THEN 1 ELSE 0 END), 0)`;
