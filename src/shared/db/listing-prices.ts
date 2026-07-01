/**
 * The `listing_prices` table: generalised per-listing pricing, one row per
 * (listing, pricing *dimension*, key within it). A `price_type` names the
 * dimension and `price_id` the key:
 *  - `("base", "")`        — the listing's single fixed price (mirrors
 *                            `listings.unit_price`).
 *  - `("day_count", "<n>")`— the price for an n-day booking (mirrors an entry of
 *                            `listings.day_prices`).
 *  - reserved for later: `("group", "<groupId>")` (package/group overrides),
 *    `("start_day", "friday")` (weekday pricing) — the shape admits them with no
 *    schema change; nothing writes them yet.
 *
 * Today the `base`/`day_count` rows are backfilled from, and kept in step with,
 * `listings.unit_price`/`day_prices`, which stay as the source-of-truth mirror
 * columns every display/API/charge caller still reads. This module owns writing
 * those rows; the read/resolve API lands with its first consumer.
 */

import { execute, executeBatch } from "#shared/db/client.ts";
import { type DayPrices, parseDayPrices } from "#shared/types.ts";

export const PRICE_TYPE_BASE = "base";
export const PRICE_TYPE_DAY_COUNT = "day_count";

/** The delete-then-insert statements that make a listing's `base`/`day_count`
 * rows exactly match `unitPrice` + `dayPrices`. Only these two managed
 * dimensions are touched — any reserved (`group`/…) rows are left untouched. A
 * day-count entry is normalised through {@link parseDayPrices} so the rows carry
 * exactly what a reader would accept. */
export const listingPriceStatements = (
  listingId: number,
  unitPrice: number,
  dayPrices: DayPrices,
): Array<{ sql: string; args: (number | string)[] }> => {
  const statements: Array<{ sql: string; args: (number | string)[] }> = [
    {
      args: [listingId, PRICE_TYPE_BASE, PRICE_TYPE_DAY_COUNT],
      sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type IN (?, ?)",
    },
    {
      args: [listingId, PRICE_TYPE_BASE, "", unitPrice],
      sql: "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?)",
    },
  ];
  for (const [days, price] of Object.entries(parseDayPrices(dayPrices))) {
    statements.push({
      args: [listingId, PRICE_TYPE_DAY_COUNT, days, price],
      sql: "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?)",
    });
  }
  return statements;
};

/** A `listings` row projected to just the columns the managed price rows mirror.
 * `day_prices` is the stored JSON text; `unit_price` may be NULL (read as 0). */
export type ListingPriceSourceRow = {
  id: number;
  unit_price: number | null;
  day_prices: string;
};

/** The managed statements that sync one raw `listings` row's `base`/`day_count`
 * rows — the {@link listingPriceStatements} call shared by the backfill and the
 * per-listing {@link syncListingPrices}, so both normalise the stored JSON the
 * same way. A NULL `unit_price` reads as 0 and blank/absent `day_prices` as an
 * empty map. */
export const sourceRowStatements = (row: ListingPriceSourceRow) =>
  listingPriceStatements(
    row.id,
    row.unit_price ?? 0,
    parseDayPrices(JSON.parse(row.day_prices || "{}")),
  );

/** Populate `listing_prices` from every listing's current `unit_price`/
 * `day_prices` — the migration backfill. Idempotent: each listing's managed
 * rows are deleted and reinserted, so re-running converges. */
export const backfillListingPrices = async (): Promise<void> => {
  const rows = await execute("SELECT id, unit_price, day_prices FROM listings");
  const statements = (rows.rows as unknown as ListingPriceSourceRow[]).flatMap(
    sourceRowStatements,
  );
  if (statements.length > 0) await executeBatch(statements);
};

/** Re-sync one listing's managed price rows from its current `listings` columns.
 * Called after every listing insert/update so the table never drifts from the
 * `unit_price`/`day_prices` mirrors. A missing listing is a no-op. */
export const syncListingPrices = async (listingId: number): Promise<void> => {
  const rows = await execute(
    "SELECT id, unit_price, day_prices FROM listings WHERE id = ?",
    [listingId],
  );
  const row = (rows.rows as unknown as ListingPriceSourceRow[])[0];
  if (row) await executeBatch(sourceRowStatements(row));
};
