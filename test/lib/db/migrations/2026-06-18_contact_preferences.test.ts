import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import contactPreferencesMigration from "#shared/db/migrations/2026-06-18_contact_preferences.ts";
import {
  applySchemaChanges,
  tableExists as schemaTableExists,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";
import { describeWithEnv } from "#test-utils";
import {
  columnNames,
  tableExists,
  tableRowCount,
} from "../migration-test-helpers.ts";

const unused = async (): Promise<void> => {
  throw new Error("unused migration context member called");
};

const context: MigrationContext = {
  additive: (migration: AdditiveMigration): Migration => ({
    ...migration,
    verify: async () => {},
  }),
  applySchemaChanges,
  backfillAnswerAggregates: unused,
  backfillListingAggregates: unused,
  backfillModifierAggregates: unused,
  ensureDefaultAttendeeStatus: unused,
  getDb,
  recreateTable: unused,
  renameEventsToListings: unused,
  syncCurrentSchema: unused,
  syncIndexes,
  syncTriggers: unused,
  tableExists: schemaTableExists,
  verifyCurrentAppSchema: unused,
  verifyRequirement: (_req: SchemaRequirement) => async () => {},
};

const runContactPreferencesMigration = () =>
  contactPreferencesMigration(context).up();

const resetContactPreferenceTables = () =>
  getDb().batch(
    [
      "DROP TABLE IF EXISTS email_preferences",
      "DROP TABLE IF EXISTS contact_preferences",
    ],
    "write",
  );

const createLegacyEmailPreferences = () =>
  getDb().execute(
    "CREATE TABLE email_preferences (email_hash TEXT PRIMARY KEY, unsubscribed INTEGER NOT NULL DEFAULT 0, created TEXT)",
  );

const createTargetContactPreferences = () =>
  getDb().execute(
    "CREATE TABLE contact_preferences (contact_hash TEXT PRIMARY KEY, unsubscribed INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, stats_blob TEXT NOT NULL DEFAULT '', last_activity INTEGER NOT NULL DEFAULT 0)",
  );

const insertLegacyPreference = (
  hash: string,
  created = "2024-01-02T03:04:05Z",
) =>
  getDb().execute({
    args: [hash, 1, created],
    sql:
      "INSERT INTO email_preferences (email_hash, unsubscribed, created) " +
      "VALUES (?, ?, ?)",
  });

const insertTargetPreference = (hash: string) =>
  getDb().execute({
    args: [hash],
    sql:
      "INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity) " +
      "VALUES (?, 1, 2, 'stats', 123)",
  });

describeWithEnv(
  "db > migrations > 2026-06-18_contact_preferences",
  { db: true },
  () => {
    describe("legacy table repair", () => {
      test("renames legacy email_preferences rows and backfills last activity", async () => {
        await resetContactPreferenceTables();
        await createLegacyEmailPreferences();
        await insertLegacyPreference("legacy-hash");
        const before = Date.now();

        await runContactPreferencesMigration();

        expect(await tableExists("email_preferences")).toBe(false);
        expect(await tableExists("contact_preferences")).toBe(true);
        expect(await columnNames("contact_preferences")).not.toContain(
          "email_hash",
        );
        expect(await columnNames("contact_preferences")).not.toContain(
          "created",
        );
        const rows = await getDb().execute(
          "SELECT contact_hash, unsubscribed, visits, stats_blob, last_activity FROM contact_preferences",
        );
        const row = rows.rows[0];
        expect(row?.contact_hash).toBe("legacy-hash");
        expect(row?.stats_blob).toBe("");
        expect(row?.unsubscribed).toBe(1);
        expect(row?.visits).toBe(0);
        const lastActivity = Number(row?.last_activity);
        expect(lastActivity).toBeGreaterThanOrEqual(before);
        expect(lastActivity).toBeLessThanOrEqual(Date.now());
      });

      test("replaces an empty target table with the populated legacy table", async () => {
        await resetContactPreferenceTables();
        await createLegacyEmailPreferences();
        await insertLegacyPreference("legacy-only");
        await createTargetContactPreferences();

        await runContactPreferencesMigration();

        expect(await tableExists("email_preferences")).toBe(false);
        expect(await tableRowCount("contact_preferences")).toBe(1);
        const rows = await getDb().execute(
          "SELECT contact_hash FROM contact_preferences",
        );
        expect(rows.rows[0]?.contact_hash).toBe("legacy-only");
      });

      test("drops an empty legacy table when the target table has rows", async () => {
        await resetContactPreferenceTables();
        await createLegacyEmailPreferences();
        await createTargetContactPreferences();
        await insertTargetPreference("target-row");

        await runContactPreferencesMigration();

        expect(await tableExists("email_preferences")).toBe(false);
        expect(await tableRowCount("contact_preferences")).toBe(1);
        const rows = await getDb().execute(
          "SELECT contact_hash, visits, stats_blob, last_activity FROM contact_preferences",
        );
        expect(rows.rows[0]).toEqual({
          contact_hash: "target-row",
          last_activity: 123,
          stats_blob: "stats",
          visits: 2,
        });
      });

      test("throws when both legacy and target tables contain rows", async () => {
        await resetContactPreferenceTables();
        await createLegacyEmailPreferences();
        await insertLegacyPreference("legacy-row");
        await createTargetContactPreferences();
        await insertTargetPreference("target-row");

        await expect(runContactPreferencesMigration()).rejects.toThrow(
          "both tables contain rows",
        );
        expect(await tableExists("email_preferences")).toBe(true);
        expect(await tableExists("contact_preferences")).toBe(true);
      });

      test("creates the target table when neither legacy nor target exists", async () => {
        await resetContactPreferenceTables();

        await runContactPreferencesMigration();

        expect(await tableExists("email_preferences")).toBe(false);
        expect(await tableExists("contact_preferences")).toBe(true);
        expect(await columnNames("contact_preferences")).toEqual([
          "contact_hash",
          "unsubscribed",
          "visits",
          "public_booking_count",
          "admin_booking_count",
          "stats_blob",
          "last_activity",
        ]);
      });

      test("leaves a target table alone when contact_hash already exists", async () => {
        await resetContactPreferenceTables();
        await createTargetContactPreferences();
        await getDb().execute(
          "ALTER TABLE contact_preferences ADD COLUMN email_hash TEXT",
        );
        await insertTargetPreference("target-with-extra-column");

        await runContactPreferencesMigration();

        const columns = await columnNames("contact_preferences");
        expect(columns).toContain("contact_hash");
        expect(columns).toContain("email_hash");
        expect(await tableRowCount("contact_preferences")).toBe(1);
      });
    });
  },
);
