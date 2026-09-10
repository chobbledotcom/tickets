import { expect } from "@std/expect";
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

/** Seed two differently-priced listings, wipe their base rows, run the given
 * backfill entry point, and assert each mirror rebuilt from its column. One
 * assertion shared by the sync suite (the mechanism) and the migration suite
 * (the wiring that runs it on upgrade). */
export const expectBackfillRebuildsBaseRows = async (
  runBackfill: () => Promise<void>,
): Promise<void> => {
  const a = await createTestListing({ unitPrice: 750 });
  const b = await createTestListing({ unitPrice: 400 });
  await queryAll("DELETE FROM listing_prices WHERE price_type = 'base'");
  await runBackfill();
  expect(await priceRows(a.id)).toEqual([
    { price_id: "", price_type: "base", unit_price: 750 },
  ]);
  expect(await priceRows(b.id)).toEqual([
    { price_id: "", price_type: "base", unit_price: 400 },
  ]);
};
