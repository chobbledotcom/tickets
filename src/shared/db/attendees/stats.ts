/**
 * Aggregated statistics for attendees across listings.
 */

import { filter, map, sumOf } from "#fp";
import type { ActiveListingStats } from "#shared/db/attendee-types.ts";
import { inPlaceholders, queryOne } from "#shared/db/client.ts";
import type { ListingWithCount } from "#shared/types.ts";

/**
 * Get aggregated statistics for active listings.
 * Filters active listings from the provided list, computes attendees
 * (sum of quantities) from cached ListingWithCount data, and reads ticket
 * count and income from the listings' precomputed tickets_count / income
 * columns (trigger-maintained), so this sums only the active listing rows
 * by primary key instead of scanning every attendee row.
 */
export const getActiveListingStats = async (
  listings: ListingWithCount[],
): Promise<ActiveListingStats> => {
  const active = filter((e: ListingWithCount) => e.active)(listings);
  if (active.length === 0) {
    return { attendees: 0, income: 0, tickets: 0 };
  }
  const activeIds = map((e: ListingWithCount) => e.id)(active);
  const attendees = sumOf((e: ListingWithCount) => e.attendee_count)(active);

  const row = (await queryOne<{ tickets: number; income: number }>(
    `SELECT COALESCE(SUM(tickets_count), 0) AS tickets,
            COALESCE(SUM(income), 0) AS income
       FROM listings
      WHERE id IN (${inPlaceholders(activeIds)})`,
    activeIds,
  ))!;
  return {
    attendees,
    income: row.income,
    tickets: row.tickets,
  };
};
