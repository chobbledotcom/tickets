/**
 * The `base` mirror: keeping the `listing_prices` `("base", "")` rows in step
 * with the `listings.unit_price` column. One mechanism serves every caller
 * — the save hook after every listing write, the seed and bulk-clone flows,
 * and the migration backfill — so validation, the guarded writes, and the
 * primary read-back cannot drift between them.
 */

import * as v from "valibot";
import {
  executeBatchWithResults,
  inPlaceholders,
  queryIdColumn,
  resultRows,
} from "#db/client.ts";
import { PRICE_TYPE_BASE } from "#db/price-types.ts";
import { chunk } from "#fp";

/** A `listings` row projected to the one column the `base` mirror derives
 *  from. `unit_price` may be NULL (mirrored as 0). */
const ListingPriceSourceRowSchema = v.object({
  id: v.number(),
  unit_price: v.nullable(v.number()),
});

/** The source check every guarded write shares: only a numeric or NULL
 *  `unit_price` can write a mirror, so a drifted text value leaves the
 *  existing rows standing instead of deleting them for a write that never
 *  lands. */
const numericUnitPrice = "typeof(unit_price) IN ('integer', 'real', 'null')";

/** Clear one listing's `base` row, but only while its source column can
 *  still write a clean mirror. */
const guardedBaseDelete = (listingId: number) => ({
  args: [listingId, PRICE_TYPE_BASE, listingId],
  sql: `DELETE FROM listing_prices
         WHERE listing_id = ? AND price_type = ?
           AND EXISTS (SELECT 1 FROM listings
                        WHERE id = ? AND ${numericUnitPrice})`,
});

/** Mirror the column on the database side — the INSERT reads the very
 *  `unit_price` it mirrors, so no separate read round trip. A missing
 *  listing inserts no row, and a NULL `unit_price` mirrors as 0. */
const guardedBaseInsert = (listingId: number) => ({
  args: [listingId, PRICE_TYPE_BASE, "", listingId],
  sql: `INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price)
        SELECT ?, ?, ?, COALESCE(unit_price, 0)
          FROM listings WHERE id = ? AND ${numericUnitPrice}`,
});

/** Listings synced per one batch — one validation read plus two guarded
 *  writes each, so a full page is 401 statements, inside the libsql batch
 *  payload limits on large sites. */
const SYNC_PAGE = 200;

/**
 * Re-sync the `base` rows of exactly these listings from their current
 * `unit_price` columns, in one batch per page. The batch's SELECT reads the
 * source first and the guarded DELETE and INSERT rewrite it in the same
 * transaction snapshot; the parse below is the loud drift check: a text
 * `unit_price` fails it while the guarded writes beside it never landed, so
 * the valid mirror is left standing. Day-count rows are written from input
 * by the write paths, not re-derived here.
 */
export const syncListingPricesForIds = async (
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) return;
  for (const page of chunk(SYNC_PAGE)([...ids])) {
    const results = await executeBatchWithResults([
      {
        args: [...page],
        sql: `SELECT id, unit_price FROM listings
               WHERE id IN (${inPlaceholders(page)})`,
      },
      ...page.flatMap((id) => [guardedBaseDelete(id), guardedBaseInsert(id)]),
    ]);
    v.parse(v.array(ListingPriceSourceRowSchema), resultRows(results[0]!));
  }
};

/** The save hook after every listing insert/update: one listing, one batch. */
export const syncListingPrices = (listingId: number): Promise<void> =>
  syncListingPricesForIds([listingId]);

/**
 * Populate every listing's `base` row from its current `unit_price` — the
 * migration backfill for the `base` mirror. Idempotent: each row is deleted
 * and reinserted, so re-running converges. (Day-count rows are backfilled by
 * the day_prices migration from the column before it is dropped; the
 * per-write paths keep them in step thereafter.)
 */
export const backfillListingPrices = async (): Promise<void> => {
  const ids = await queryIdColumn("SELECT id FROM listings ORDER BY id");
  await syncListingPricesForIds(ids);
};
