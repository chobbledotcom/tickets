/** Listing aggregate inspection, correction, and rebuilding. */

import { inOwnTx, ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { execute, requireOne, resetAggregates } from "#shared/db/client.ts";
import type {
  AggregateRecalculation,
  AggregateValues,
} from "#shared/db/common-schema.ts";
import {
  ticketCountPredicateFor,
  ticketCountSumExpr,
} from "#shared/db/migrations/schema/listing-aggregates.ts";
import type { ListingWithCount } from "#shared/types.ts";

export const LISTING_AGGREGATE_FIELDS = [
  "booked_quantity",
  "tickets_count",
] as const;

export type ListingAggregateField = (typeof LISTING_AGGREGATE_FIELDS)[number];
export type ListingAggregateValues = AggregateValues<ListingAggregateField>;
export type ListingAggregateRecalculation =
  AggregateRecalculation<ListingAggregateField>;

const LISTING_AGGREGATE_RECALC_SQL = `SELECT
       COALESCE(SUM(listingAttendee.quantity), 0) AS booked_quantity,
       ${ticketCountSumExpr()} AS tickets_count
     FROM listing_attendees AS listingAttendee
     WHERE listingAttendee.listing_id = ?`;

/** Compare stored listing aggregates with the values rebuilt from bookings. */
export const getListingAggregateRecalculation = async (
  listing: ListingWithCount,
): Promise<ListingAggregateRecalculation> => {
  const row = await requireOne<ListingAggregateValues>(
    LISTING_AGGREGATE_RECALC_SQL,
    [listing.id],
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

/** Manually set every editable listing aggregate. */
export const updateListingAggregateValues = async (
  listingId: number,
  values: ListingAggregateValues,
): Promise<void> => {
  await execute(
    "UPDATE listings AS listing SET booked_quantity = ?, tickets_count = ? WHERE listing.id = ?",
    [values.booked_quantity, values.tickets_count, listingId],
  );
};

/** Correct projected listing income to the requested amount. */
export const adjustListingIncome = (
  listingId: number,
  targetIncome: number,
): Promise<void> => inOwnTx(ledgerTx.correct.income)(listingId, targetIncome);

const aggregateResetSql: Record<ListingAggregateField, string> = {
  booked_quantity:
    "booked_quantity = COALESCE((SELECT SUM(listingAttendee.quantity) FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = ?), 0)",
  tickets_count: `tickets_count = (SELECT COUNT(*) FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = ? AND ${ticketCountPredicateFor(
    "listingAttendee.quantity",
    "listingAttendee.attendee_id",
  )})`,
};

/** Reset selected listing aggregate columns from booking rows. */
export const resetListingAggregateFields = async (
  listingId: number,
  fields: ListingAggregateField[],
): Promise<void> => {
  await resetAggregates("listings", listingId, fields, aggregateResetSql);
};
