import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import dropListingIncomeMigration from "#shared/db/migrations/2026-06-22_drop_listing_income.ts";
import {
  recreateTable,
  syncTriggers,
} from "#shared/db/migrations/schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

// Promise<never> so one stub satisfies both the void- and boolean-returning
// context members; this migration's up() touches only the three below.
const unused = async (): Promise<never> => {
  throw new Error("unused migration context member called");
};

const context: MigrationContext = {
  additive: (migration: AdditiveMigration): Migration => ({
    ...migration,
    verify: async () => {},
  }),
  applySchemaChanges: unused,
  backfillAnswerAggregates: unused,
  backfillListingAggregates: unused,
  backfillModifierAggregates: unused,
  ensureDefaultAttendeeStatus: unused,
  getDb,
  recreateTable,
  renameEventsToListings: unused,
  syncCurrentSchema: unused,
  syncIndexes: unused,
  syncTriggers,
  tableExists: unused,
  verifyCurrentAppSchema: unused,
  verifyRequirement: (_req: SchemaRequirement) => async () => {},
};

const runMigration = () => dropListingIncomeMigration(context).up();

const AGGREGATE_TRIGGERS = [
  "trg_listing_attendees_aggregates_insert",
  "trg_listing_attendees_aggregates_delete",
  "trg_listing_attendees_aggregates_update",
];

/** The old income-maintaining SET clause (signed `+`/`-`) the pre-drop triggers
 *  used, so the fixture mirrors a real pre-migration database whose triggers
 *  still reference the income column. */
const contribution = (sign: "+" | "-", row: "NEW" | "OLD"): string =>
  `UPDATE listings SET
     booked_quantity = booked_quantity ${sign} ${row}.quantity,
     tickets_count = tickets_count ${sign} 1,
     income = income ${sign} ${row}.price_paid
   WHERE id = ${row}.listing_id;`;

/** Recreate the legacy income-maintaining triggers (dropped by the migration). */
const installLegacyTriggers = async (): Promise<void> => {
  const bodies: Record<string, string> = {
    trg_listing_attendees_aggregates_delete: `AFTER DELETE ON listing_attendees
FOR EACH ROW BEGIN
  ${contribution("-", "OLD")}
END`,
    trg_listing_attendees_aggregates_insert: `AFTER INSERT ON listing_attendees
FOR EACH ROW BEGIN
  ${contribution("+", "NEW")}
END`,
    trg_listing_attendees_aggregates_update: `AFTER UPDATE OF quantity, price_paid, listing_id ON listing_attendees
FOR EACH ROW BEGIN
  ${contribution("-", "OLD")}
  ${contribution("+", "NEW")}
END`,
  };
  for (const name of AGGREGATE_TRIGGERS) {
    await getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
    await getDb().execute(`CREATE TRIGGER ${name} ${bodies[name]}`);
  }
};

/** Build the pre-migration state: the income column restored and the legacy
 *  income-maintaining triggers in place (as a production DB had before drop). */
const seedPreDropSchema = async (): Promise<void> => {
  await getDb().execute(
    "ALTER TABLE listings ADD COLUMN income INTEGER NOT NULL DEFAULT 0",
  );
  await installLegacyTriggers();
};

const listingColumns = async (): Promise<string[]> => {
  const result = await getDb().execute("PRAGMA table_info(listings)");
  return result.rows.map((row) => String(row.name));
};

const triggerNames = async (): Promise<Set<string>> => {
  const result = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  );
  return new Set(result.rows.map((row) => String(row.name)));
};

const listingAggregates = async (
  listingId: number,
): Promise<{ booked_quantity: number; tickets_count: number }> => {
  const result = await getDb().execute({
    args: [listingId],
    sql: "SELECT booked_quantity, tickets_count FROM listings WHERE id = ?",
  });
  const row = result.rows[0]!;
  return {
    booked_quantity: Number(row.booked_quantity),
    tickets_count: Number(row.tickets_count),
  };
};

describeWithEnv(
  "db > migrations > 2026-06-22_drop_listing_income",
  { db: true, triggers: true },
  () => {
    test("drops the income column from listings", async () => {
      await seedPreDropSchema();
      expect(await listingColumns()).toContain("income");
      await runMigration();
      expect(await listingColumns()).not.toContain("income");
    });

    test("keeps the three aggregate triggers in place", async () => {
      await seedPreDropSchema();
      await runMigration();
      const triggers = await triggerNames();
      for (const name of AGGREGATE_TRIGGERS) {
        expect(triggers.has(name)).toBe(true);
      }
    });

    test("rebuilt triggers still maintain the counts without an income column", async () => {
      // Create the listing before restoring the income column, so the app's
      // ledger-based read (which already aliases its own `income`) isn't run
      // against a table that also carries a stored income column.
      const listing = await createTestListing({ maxAttendees: 50 });
      await seedPreDropSchema();
      await runMigration();

      // The legacy triggers referenced income; if the migration had not replaced
      // them, this insert would fail on the now-missing column.
      await getDb().execute({
        args: [listing.id],
        sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, 1, 3)",
      });

      expect(await listingAggregates(listing.id)).toEqual({
        booked_quantity: 3,
        tickets_count: 1,
      });
    });
  },
);
