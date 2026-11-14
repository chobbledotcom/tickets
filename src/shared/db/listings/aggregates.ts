/** Listing aggregate inspection, correction, and rebuilding. */

import { inOwnTx, ledgerTx } from "#accounting/ledger-tx.ts";
import { requireOne } from "#db/client.ts";
import {
  type AggregateRecalculation,
  type AggregateValues,
  aggregateRepairs,
} from "#db/common-schema.ts";
import {
  ticketCountPredicateFor,
  ticketCountSumExpr,
} from "#db/migrations/schema/listing-aggregates.ts";
import { sql } from "#db/sql.ts";
import type { ListingWithCount } from "#types";

export const LISTING_AGGREGATE_FIELDS = [
  "booked_quantity",
  "tickets_count",
] as const;

export type ListingAggregateField = (typeof LISTING_AGGREGATE_FIELDS)[number];
export type ListingAggregateValues = AggregateValues<ListingAggregateField>;
export type ListingAggregateRecalculation =
  AggregateRecalculation<ListingAggregateField>;

const listingAggregateRecalcSql = (listingId: number) => sql`SELECT
       COALESCE(SUM(listingAttendee.quantity), 0) AS booked_quantity,
       ${ticketCountSumExpr()} AS tickets_count
     FROM listing_attendees AS listingAttendee
     WHERE listingAttendee.listing_id = ${listingId}`;

/** Compare stored listing aggregates with the values rebuilt from bookings. */
export const getListingAggregateRecalculation = async (
  listing: ListingWithCount,
): Promise<ListingAggregateRecalculation> => {
  const row = await requireOne<ListingAggregateValues>(
    listingAggregateRecalcSql(listing.id),
  );
  return {
    booked_quantity: {
      current: listing.attendee_count,
      recalculated: row.booked_quantity,
    },
    tickets_count: {
      current: listing.tickets_count,
      recalculated: row.tickets_count,
    },
  };
};

/** Correct projected listing income to the requested amount. */
export const adjustListingIncome = (
  listingId: number,
  targetIncome: number,
): Promise<void> => inOwnTx(ledgerTx.correct.income)(listingId, targetIncome);

/** Write the operator's typed listing aggregates, or rebuild chosen ones from
 * the booking rows they count. */
export const listingAggregates = aggregateRepairs<ListingAggregateField>(
  "listings",
  {
    booked_quantity: sql`COALESCE((SELECT SUM(listingAttendee.quantity) FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = listings.id), 0)`,
    tickets_count: sql`(SELECT COUNT(*) FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = listings.id AND ${ticketCountPredicateFor(
      sql`listingAttendee.quantity`,
      sql`listingAttendee.attendee_id`,
    )})`,
  },
);
