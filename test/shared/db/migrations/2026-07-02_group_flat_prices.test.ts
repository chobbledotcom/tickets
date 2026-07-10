import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#shared/db/client.ts";
import groupFlatPricesMigration from "#shared/db/migrations/2026-07-02_group_flat_prices.ts";
import { recreateTable } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

// The migration's up() reads the live schema and rebuilds group_listings; getDb
// is real by default, recreateTable does the column drop.
const context = buildMigrationContext({ recreateTable });
const runMigration = () => groupFlatPricesMigration(context).up();

/** Re-add the legacy `package_price` column to the freshly-migrated (column-free)
 * group_listings table, so the fixture mirrors a real pre-migration database.
 * A test DB is built from the current SCHEMA, which no longer has the column. */
const addLegacyColumn = (): Promise<unknown> =>
  getDb().execute(
    "ALTER TABLE group_listings ADD COLUMN package_price INTEGER",
  );

/** Insert a legacy membership row carrying a `package_price` value. */
const seedMember = (
  groupId: number,
  listingId: number,
  quantity: number,
  packagePrice: number | null,
): Promise<unknown> =>
  getDb().execute({
    args: [groupId, listingId, quantity, packagePrice],
    sql: "INSERT INTO group_listings (group_id, listing_id, quantity, package_price) VALUES (?, ?, ?, ?)",
  });

/** The migrated `group` price rows, ordered for stable assertions. */
const groupPriceRows = (): Promise<
  { listing_id: number; price_id: string; unit_price: number }[]
> =>
  queryAll(
    `SELECT listing_id, price_id, unit_price FROM listing_prices
      WHERE price_type = 'group' ORDER BY price_id, listing_id`,
  );

const groupListingsColumns = async (): Promise<string[]> => {
  const info = await getDb().execute("PRAGMA table_info(group_listings)");
  return info.rows.map((row) => String(row.name));
};

describeWithEnv(
  "db > migrations > 2026-07-02_group_flat_prices",
  { db: true },
  () => {
    test("backfills each non-null package_price into a 'group' price row and drops the column", async () => {
      await addLegacyColumn();
      // A positive override, an explicit free (0), and a no-override (NULL) in
      // one group, plus the same listing overridden in a second group.
      await seedMember(1, 10, 2, 500);
      await seedMember(1, 11, 1, 0);
      await seedMember(1, 12, 1, null);
      await seedMember(2, 10, 1, 750);

      await runMigration();

      // NULL contributes no row; 0 and positive do. Each keyed by its group.
      expect(await groupPriceRows()).toEqual([
        { listing_id: 10, price_id: "1", unit_price: 500 },
        { listing_id: 11, price_id: "1", unit_price: 0 },
        { listing_id: 10, price_id: "2", unit_price: 750 },
      ]);
      // The column is gone but membership + quantity survive the rebuild.
      expect(await groupListingsColumns()).not.toContain("package_price");
      const rows = await queryAll<{ listing_id: number; quantity: number }>(
        "SELECT listing_id, quantity FROM group_listings WHERE group_id = 1 ORDER BY listing_id",
      );
      expect(rows).toEqual([
        { listing_id: 10, quantity: 2 },
        { listing_id: 11, quantity: 1 },
        { listing_id: 12, quantity: 1 },
      ]);
    });

    test("is a no-op when the legacy column is already gone (idempotent re-run)", async () => {
      await addLegacyColumn();
      await seedMember(3, 20, 1, 900);
      await runMigration();
      const afterFirst = await groupPriceRows();
      expect(afterFirst).toEqual([
        { listing_id: 20, price_id: "3", unit_price: 900 },
      ]);

      // Second run: the column is gone, so it must neither throw nor duplicate.
      await runMigration();
      expect(await groupPriceRows()).toEqual(afterFirst);
    });
  },
);
