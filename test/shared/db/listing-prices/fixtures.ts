import { queryAll } from "#db/client.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { ListingWithCount } from "#types";

/** The managed rows for a listing, ordered for stable assertions. */
export const priceRows = (
  listingId: number,
): Promise<{ price_type: string; price_id: string; unit_price: number }[]> =>
  queryAll(
    `SELECT price_type, price_id, unit_price FROM listing_prices
      WHERE listing_id = ? ORDER BY price_type, price_id`,
    [listingId],
  );

/** Create a customisable listing with the given per-day-count prices through
 * the real admin form path (which writes the day_count rows). */
export const createDayPricedListing = (
  dayPrices: Record<number, number>,
): Promise<ListingWithCount> =>
  createTestListing({
    customisableDays: true,
    dayPrices,
    durationDays: 5,
    unitPrice: 0,
  });
