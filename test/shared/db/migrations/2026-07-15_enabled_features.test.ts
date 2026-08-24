import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import enabledFeaturesMigration from "#db/migrations/2026-07-15_enabled_features.ts";
import { ADMIN_FEATURE_TRIGGER_NAMES } from "#db/migrations/schema/admin-feature-triggers.ts";
import { syncTriggers } from "#db/migrations/schema-sync.ts";
import { CONFIG_KEYS } from "#db/settings.ts";
import {
  parseEnabledFeatures,
  serializeEnabledFeatures,
} from "#shared/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import {
  SEEDED_FEATURE_RECORDS,
  seedFeatureRecords,
} from "#test-utils/settings.ts";

const context = buildMigrationContext({ syncTriggers });
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
      await seedFeatureRecords();

      await runMigration();

      expect(await storedFeatures()).toEqual(SEEDED_FEATURE_RECORDS);
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
        "Move admin feature visibility into one plain enabled-features setting and keep it in step with saved feature data.",
      );
      expect(migration.requires?.triggers).toEqual(ADMIN_FEATURE_TRIGGER_NAMES);
    });
  },
);
