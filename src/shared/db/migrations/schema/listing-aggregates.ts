/** Pure predicates and SQL expressions for the listing count aggregates. */

import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";

/**
 * The listing_attendees columns that shift the listing count aggregates
 * (booked_quantity, tickets_count). The UPDATE trigger fires on exactly these
 * columns; the cache-invalidation gate in listings.ts reads the same constant so
 * the two cannot drift. price_paid is no longer here — income is projected from
 * the transfers ledger at read time, not maintained from this column.
 */
export const LISTING_AGGREGATE_WRITE_COLUMNS = [
  "quantity",
  "listing_id",
] as const;

/**
 * The predicate deciding whether a listing_attendees row counts toward
 * listings.tickets_count. A quantity = 0 line is the "no quantity" sentinel — it
 * keeps the attendee↔listing link but is not a ticket — so tickets_count counts
 * only rows where quantity > 0. booked_quantity (SUM(quantity)) already treats 0
 * correctly and must NOT use this predicate.
 *
 * Every site that computes tickets_count references this one constant so the
 * rule cannot silently diverge (mirrors LISTING_AGGREGATE_WRITE_COLUMNS): the
 * three triggers below, the two queries in listings.ts (reset + recalculation),
 * the schema-sync backfill, and the hold-delete restore in attendees/delete.ts.
 * A guard test asserts the predicate appears at every one of those sites.
 */
export const TICKET_COUNTS_PREDICATE = `quantity > 0 AND kind = '${ATTENDEE_KIND}'`;

/** Predicate wrapper for contexts that have a listing_attendees row but need
 * the attendee kind. Missing attendee rows are treated as legacy attendee rows
 * so raw trigger tests and old FK-less data keep their historical ticket count. */
export const ticketCountPredicateFor = (
  quantityExpr: string,
  attendeeIdExpr: string,
): string =>
  `EXISTS (SELECT 1 FROM (SELECT ${quantityExpr} AS quantity, ` +
  `CASE WHEN EXISTS (SELECT 1 FROM attendees AS attendee WHERE attendee.id = ${attendeeIdExpr}) ` +
  `THEN (SELECT attendee.kind FROM attendees AS attendee WHERE attendee.id = ${attendeeIdExpr}) ` +
  `ELSE '${ATTENDEE_KIND}' END AS kind) ` +
  `WHERE ${TICKET_COUNTS_PREDICATE})`;

/**
 * tickets_count as a COALESCE(SUM(CASE …)) over {@link TICKET_COUNTS_PREDICATE},
 * for the recalculation/restore SELECTs that compute it in one pass alongside
 * SUM(quantity). COALESCE because SUM over zero rows is NULL (unlike COUNT(*)'s
 * 0), so an empty listing would otherwise report bogus drift against a stored 0.
 */
export const ticketCountSumExpr = (): string =>
  `COALESCE(SUM(CASE WHEN ${ticketCountPredicateFor(
    "quantity",
    "attendee_id",
  )} THEN 1 ELSE 0 END), 0)`;
