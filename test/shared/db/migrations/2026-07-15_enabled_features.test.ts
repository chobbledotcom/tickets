import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { parseEnabledFeatures } from "#shared/admin-features.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import enabledFeaturesMigration from "#shared/db/migrations/2026-07-15_enabled_features.ts";
import { CONFIG_KEYS } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({});
const DEFAULT_ENABLED_FEATURES = parseEnabledFeatures("");
const runMigration = (): Promise<void> =>
  enabledFeaturesMigration(context).up();

const storedFeatures = async (): Promise<unknown> => {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.ENABLED_FEATURES],
  );
  if (!row) throw new Error("enabled_features was not stored");
  return JSON.parse(row.value);
};

describeWithEnv(
  "db > migrations > 2026-07-15_enabled_features",
  { db: true },
  () => {
    test("stores every feature disabled when no feature is in use", async () => {
      await runMigration();
      expect(await storedFeatures()).toEqual(DEFAULT_ENABLED_FEATURES);
    });

    test("enables features that already have saved records", async () => {
      await execute(
        "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
      );
      await execute(
        "INSERT INTO logistics_agents (name) VALUES ('Delivery team')",
      );
      await execute(
        "INSERT INTO api_keys (user_id, key_index, wrapped_data_key, name, created) VALUES (1, 'index', 'key', 'Sync', '2026-07-15')",
      );
      await execute(
        "INSERT INTO attendees (created, kind) VALUES ('2026-07-15', 'servicing')",
      );

      await runMigration();

      expect(await storedFeatures()).toEqual({
        apiKeys: true,
        logistics: true,
        modifiers: true,
        money: false,
        servingEvents: true,
      });
    });

    test("moves the old logistics setting and removes its row", async () => {
      await execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('has_logistics', 'true')",
      );
      await runMigration();

      expect(await storedFeatures()).toEqual({
        ...DEFAULT_ENABLED_FEATURES,
        logistics: true,
      });
      expect(
        await queryOne(
          "SELECT value FROM settings WHERE key = 'has_logistics'",
        ),
      ).toBeNull();
    });

    test("counts a logistics listing and stays idempotent", async () => {
      await execute(
        "INSERT INTO listings (created, max_attendees, uses_logistics) VALUES ('2026-07-15', 10, 1)",
      );
      await runMigration();
      await runMigration();
      expect(await storedFeatures()).toEqual({
        ...DEFAULT_ENABLED_FEATURES,
        logistics: true,
      });
    });

    test("keeps its recorded marker identity", () => {
      const migration = enabledFeaturesMigration(context);
      expect(migration.id).toBe("2026-07-15_enabled_features");
      expect(migration.description).toBe(
        "Move admin feature visibility into one plain enabled-features setting.",
      );
    });
  },
);
