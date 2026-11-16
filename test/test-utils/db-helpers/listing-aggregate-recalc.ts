import { expect } from "@std/expect";
import { getDb } from "#db/client.ts";
import {
  getListingAggregateRecalculation,
  type ListingAggregateRecalculation,
  listingAggregates,
} from "#db/listings/aggregates.ts";
import {
  getListingWithCount,
  invalidateListingsCache,
} from "#db/listings/records.ts";
import { sql } from "#db/sql.ts";
import type { ListingWithCount } from "#types";

/** The recalculation and the totals the listing carries after it lands. */
export type RecalculatedListingTotals = {
  after: ListingWithCount | null;
  recalc: ListingAggregateRecalculation;
};

/**
 * Reset the trigger-maintained totals, recompute them from the live rows, and
 * write the result back. The caller then asserts both values and the totals the
 * triggers now maintain.
 */
export const recalculateListingAggregates = async (
  listingId: number,
): Promise<RecalculatedListingTotals> => {
  await listingAggregates.reset(listingId, ["bookedQuantity", "ticketsCount"]);
  const recalc = await getListingAggregateRecalculation(
    (await getListingWithCount(listingId))!,
  );
  await getDb().execute(
    sql`UPDATE listings SET booked_quantity = ${recalc.booked_quantity.recalculated}, tickets_count = ${recalc.tickets_count.recalculated} WHERE id = ${listingId}`,
  );
  invalidateListingsCache();
  return { after: await getListingWithCount(listingId), recalc };
};

/** Assert that the recalculation and the re-read totals agree on the split: a
 *  servicing hold counts toward booked_quantity alone. */
export const expectListingAggregateSplit = (
  { after, recalc }: RecalculatedListingTotals,
  split: { booked_quantity: number; tickets_count: number },
): void => {
  expect(recalc.booked_quantity.recalculated).toBe(split.booked_quantity);
  expect(recalc.tickets_count.recalculated).toBe(split.tickets_count);
  expect(after?.attendeeCount).toBe(split.booked_quantity);
  expect(after?.ticketsCount).toBe(split.tickets_count);
};
