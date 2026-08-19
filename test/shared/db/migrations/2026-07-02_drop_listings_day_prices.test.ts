import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#db/client.ts";
import dropListingsDayPricesMigration from "#db/migrations/2026-07-02_drop_listings_day_prices.ts";
import { recreateTable } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

// The migration's up() reads the live schema and rebuilds listings; getDb is real
// by default, recreateTable does the column drop.
const context = buildMigrationContext({ recreateTable });
const runMigration = () => dropListingsDayPricesMigration(context).up();

/** Re-add the legacy `day_prices` column (a test DB is built from the current,
 * column-free SCHEMA) so the fixture mirrors a real pre-migration database. */
const addLegacyColumn = (): Promise<unknown> =>
  getDb().execute(
    "ALTER TABLE listings ADD COLUMN day_prices TEXT NOT NULL DEFAULT '{}'",
  );

/** Insert a bare listing row carrying a `day_prices` JSON value. */
const seedListing = (id: number, dayPrices: string): Promise<unknown> =>
  getDb().execute({
    args: [id, dayPrices],
    sql: "INSERT INTO listings (id, created, max_attendees, day_prices) VALUES (?, '2026-07-02', 10, ?)",
  });

/** The `day_count` rows, ordered for stable assertions. */
const dayCountRows = (): Promise<
  { listing_id: number; price_id: string; unit_price: number }[]
> =>
  queryAll(
    `SELECT listing_id, price_id, unit_price FROM listing_prices
      WHERE price_type = 'day_count' ORDER BY listing_id, CAST(price_id AS INTEGER)`,
  );

const listingsColumns = async (): Promise<string[]> => {
  const info = await getDb().execute("PRAGMA table_info(listings)");
  return info.rows.map((row) => String(row.name));
};

describeWithEnv(
  "db > migrations > 2026-07-02_drop_listings_day_prices",
  { db: true },
  () => {
    test("rebuilds day_count rows from the column then drops it", async () => {
      await addLegacyColumn();
      await seedListing(10, '{"1":400,"3":1000}');
      await seedListing(11, "{}");
      // A stale day_count row for listing 10 must be replaced by the column's
      // authoritative contents (the migration does a full DELETE + rebuild).
      await getDb().execute(
        "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (10, 'day_count', '9', 99)",
      );

      await runMigration();

      // Exactly the column's entries; the stale 9-day row is gone.
      expect(await dayCountRows()).toEqual([
        { listing_id: 10, price_id: "1", unit_price: 400 },
        { listing_id: 10, price_id: "3", unit_price: 1000 },
      ]);
      // The column is gone; the listing rows survive the rebuild.
      expect(await listingsColumns()).not.toContain("day_prices");
      const ids = await queryAll<{ id: number }>(
        "SELECT id FROM listings ORDER BY id",
      );
      expect(ids).toEqual([{ id: 10 }, { id: 11 }]);
    });

    test("is a no-op when the legacy column is already gone (idempotent re-run)", async () => {
      await addLegacyColumn();
      await seedListing(20, '{"2":800}');
      await runMigration();
      const afterFirst = await dayCountRows();
      expect(afterFirst).toEqual([
        { listing_id: 20, price_id: "2", unit_price: 800 },
      ]);

      // Second run: the column is gone, so it must neither throw nor wipe the rows.
      await runMigration();
      expect(await dayCountRows()).toEqual(afterFirst);
    });
  },
);
