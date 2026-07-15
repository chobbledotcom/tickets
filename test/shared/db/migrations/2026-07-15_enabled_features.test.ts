import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  parseEnabledFeatures,
  serializeEnabledFeatures,
} from "#shared/admin-features.ts";
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
      await execute("INSERT INTO attributes (name) VALUES ('Level')");
      await execute(
        "INSERT INTO questions (text, display_type) VALUES ('Notes?', 'free_text')",
      );
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
        attributes: true,
        logistics: true,
        modifiers: true,
        money: false,
        questions: true,
        servicing: true,
        site: false,
      });
    });

    test("moves old feature settings and removes their rows", async () => {
      await execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('has_logistics', 'true')",
      );
      await execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('show_public_site', 'true')",
      );
      await runMigration();

      expect(await storedFeatures()).toEqual({
        ...DEFAULT_ENABLED_FEATURES,
        logistics: true,
        site: true,
      });
      expect(
        await queryOne(
          "SELECT value FROM settings WHERE key = 'has_logistics'",
        ),
      ).toBeNull();
      expect(
        await queryOne(
          "SELECT value FROM settings WHERE key = 'show_public_site'",
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

    test("keeps Site enabled when the migration runs again", async () => {
      await execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('show_public_site', 'true')",
      );
      await runMigration();
      await runMigration();
      expect(await storedFeatures()).toEqual({
        ...DEFAULT_ENABLED_FEATURES,
        site: true,
      });
    });

    test("keeps every explicit feature choice when the migration runs again", async () => {
      const enabled = Object.fromEntries(
        Object.keys(DEFAULT_ENABLED_FEATURES).map((key) => [key, true]),
      ) as typeof DEFAULT_ENABLED_FEATURES;
      await execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [CONFIG_KEYS.ENABLED_FEATURES, serializeEnabledFeatures(enabled)],
      );

      await runMigration();

      expect(await storedFeatures()).toEqual(enabled);
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
