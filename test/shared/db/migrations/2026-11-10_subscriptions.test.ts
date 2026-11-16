import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { enabledFeaturesAreValidSql } from "#db/admin-feature-sql.ts";
import { execute, executeBatch, getDb } from "#db/client.ts";
import subscriptions from "#db/migrations/2026-11-10_subscriptions.ts";
import {
  applySchemaChanges,
  syncIndexes,
  syncTriggers,
} from "#db/migrations/schema-sync.ts";
import { sql, sqlName, sqlNames } from "#db/sql.ts";
import { parseEnabledFeatures } from "#shared/admin-features.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({
  applySchemaChanges,
  syncIndexes,
  syncTriggers,
});
const TRIGGERS = [
  "trg_admin_feature_subscriptions_listings_insert",
  "trg_admin_feature_subscriptions_listings_update",
];
const BOOKING_COLUMNS = [
  "recurring_price",
  "recurring_tax",
  "recurring_interval",
  "subscription_id",
  "subscription_status",
];

/** Put the tables back to how a site stood before subscriptions. */
const removeSubscriptions = (): Promise<unknown> =>
  executeBatch([
    ...TRIGGERS.map((name) => sql`DROP TRIGGER ${sqlName(name)}`),
    ...["recurring_price", "recurring_interval"].map(
      (column) => sql`ALTER TABLE listings DROP COLUMN ${sqlName(column)}`,
    ),
    ...BOOKING_COLUMNS.map(
      (column) =>
        sql`ALTER TABLE listing_attendees DROP COLUMN ${sqlName(column)}`,
    ),
  ]);

describeWithEnv("db > migrations > subscriptions", { db: true }, () => {
  test("starts every stored listing and booking row with no subscription", async () => {
    await executeBatch([
      sql`INSERT INTO listings (id, created, max_attendees) VALUES (9101, '2026-11-01', 5)`,
      sql`INSERT INTO listing_attendees (attendee_id, listing_id) VALUES (1, 9101)`,
    ]);
    await removeSubscriptions();

    await subscriptions(context).up();

    const listing = await getDb().execute(
      sql`SELECT recurring_price, recurring_interval FROM listings WHERE id = 9101`,
    );
    expect({ ...listing.rows[0] }).toEqual({
      recurring_interval: "",
      recurring_price: 0,
    });
    const booking = await getDb().execute(
      sql`SELECT ${sqlNames(BOOKING_COLUMNS)} FROM listing_attendees WHERE listing_id = 9101`,
    );
    expect({ ...booking.rows[0] }).toEqual({
      recurring_interval: "",
      recurring_price: 0,
      recurring_tax: 0,
      subscription_id: "",
      subscription_status: "",
    });
    const triggers = await getDb().execute(
      sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_admin_feature_subscriptions_%' ORDER BY name`,
    );
    expect(triggers.rows.map((row) => row.name)).toEqual(TRIGGERS);
  });

  test("turns the subscriptions feature off in a feature list saved before it existed", async () => {
    const before = { ...parseEnabledFeatures(""), apiKeys: true };
    const { subscriptions: _absent, ...saved } = before;
    await execute(
      sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${CONFIG_KEYS.ENABLED_FEATURES}, ${JSON.stringify(saved)})`,
    );
    await removeSubscriptions();

    await subscriptions(context).up();

    const stored = await getDb().execute(
      sql`SELECT value, ${enabledFeaturesAreValidSql(sql`value`)} AS valid
              FROM settings WHERE key = ${CONFIG_KEYS.ENABLED_FEATURES}`,
    );
    const [row] = stored.rows;
    expect([JSON.parse(String(row?.value)), row?.valid]).toEqual([
      { ...before, subscriptions: false },
      1,
    ]);
  });
});
