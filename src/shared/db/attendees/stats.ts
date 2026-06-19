/**
 * Aggregated statistics for attendees across listings.
 */

import { filter, sumOf } from "#fp";
import type { ActiveListingStats } from "#shared/db/attendee-types.ts";
import type { ListingWithCount } from "#shared/types.ts";

/**
 * Get aggregated statistics for active listings.
 * All three values are summed from the precomputed aggregate columns on
 * ListingWithCount (trigger-maintained), which are already in memory from the
 * caller's getAllListings() fetch — no additional DB query needed.
 */
export const getActiveListingStats = (
  listings: ListingWithCount[],
): ActiveListingStats => {
  const active = filter((e: ListingWithCount) => e.active)(listings);
  if (active.length === 0) {
    return { attendees: 0, income: 0, tickets: 0 };
  }
  return {
    attendees: sumOf((e: ListingWithCount) => e.attendee_count)(active),
    income: sumOf((e: ListingWithCount) => e.income)(active),
    tickets: sumOf((e: ListingWithCount) => e.tickets_count)(active),
  };
};
