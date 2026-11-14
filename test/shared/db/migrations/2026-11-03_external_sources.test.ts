import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import externalSourcesMigration from "#db/migrations/2026-11-03_external_sources.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import { initDb, LATEST_UPDATE } from "#db/migrations.ts";
import { CONFIG_KEYS } from "#db/settings.ts";
import { parseEnabledFeatures } from "#shared/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  buildMigrationContext,
  settingsValueOrNull,
  simulateUpgradeFromRelease,
} from "#test-utils/migrations.ts";
import { sql } from "#db/sql.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });

const runMigration = (): Promise<void> =>
  externalSourcesMigration(context).up();

/** The feature setting the release before this migration stored: every key but
 *  the one this migration adds. */
const settingFromPreviousRelease = (): string => {
  const { externalSources: _newFeature, ...previousFeatures } =
    parseEnabledFeatures("");
  return JSON.stringify({ ...previousFeatures, money: true });
};

const storeFeatures = async (value: string): Promise<void> => {
  await execute(sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${CONFIG_KEYS.ENABLED_FEATURES}, ${value})`);
};

const storedFeatures = async () => {
  const stored = await settingsValueOrNull(CONFIG_KEYS.ENABLED_FEATURES);
  if (stored === null) throw new Error("enabled_features was not stored");
  return parseEnabledFeatures(stored);
};

describeWithEnv(
  "db > migrations > 2026-11-03_external_sources",
  { db: true },
  () => {
    test("declares its identity, tables, and indexes", () => {
      const migration = externalSourcesMigration(context);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description:
          "Add the external sources directory, its links to records, and the feature that shows it",
        id: "2026-11-03_external_sources",
        requires: {
          indexes: [
            "idx_external_source_links_lookup",
            "idx_external_source_links_external",
            "idx_external_source_links_target",
          ],
          newTables: ["external_sources", "external_source_links"],
        },
      });
    });

    test("adds the feature as off to a setting written before this release", async () => {
      await storeFeatures(settingFromPreviousRelease());

      await runMigration();

      expect(await storedFeatures()).toEqual({
        ...parseEnabledFeatures(""),
        money: true,
      });
    });

    test("keeps a stored choice for the feature", async () => {
      await storeFeatures(
        JSON.stringify({ ...parseEnabledFeatures(""), externalSources: true }),
      );

      await runMigration();

      expect(await storedFeatures()).toEqual({
        ...parseEnabledFeatures(""),
        externalSources: true,
      });
    });

    test("runs on a site upgrading from the previous release", async () => {
      await storeFeatures(settingFromPreviousRelease());
      await simulateUpgradeFromRelease(
        "Store every listing's contact fields as trimmed, comma-joined tokens.",
        "2026-11-03_external_sources",
      );

      await initDb();

      expect(await storedFeatures()).toEqual({
        ...parseEnabledFeatures(""),
        money: true,
      });
      expect(await settingsValueOrNull("latest_db_update")).toBe(LATEST_UPDATE);
    });
  },
);
