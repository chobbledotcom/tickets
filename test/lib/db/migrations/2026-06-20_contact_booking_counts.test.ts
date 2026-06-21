import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import contactBookingCountsMigration from "#shared/db/migrations/2026-06-20_contact_booking_counts.ts";
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

const runMigration = () => contactBookingCountsMigration(context).up();

/** Recreate contact_preferences in its pre-split shape (no booking-count
 * columns) so the migration has to add them and run the backfill. */
const createPreSplitTable = () =>
  getDb().batch(
    [
      "DROP TABLE IF EXISTS contact_preferences",
      "CREATE TABLE contact_preferences (contact_hash TEXT PRIMARY KEY, unsubscribed INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, stats_blob TEXT NOT NULL DEFAULT '', last_activity INTEGER NOT NULL DEFAULT 0)",
    ],
    "write",
  );

const insertContact = (hash: string, visits: number) =>
  getDb().execute({
    args: [hash, visits],
    sql: "INSERT INTO contact_preferences (contact_hash, visits) VALUES (?, ?)",
  });

describeWithEnv(
  "db > migrations > 2026-06-20_contact_booking_counts",
  { db: true },
  () => {
    describe("booking-count backfill", () => {
      test("seeds public_booking_count from visits for pre-split contacts", async () => {
        await createPreSplitTable();
        await insertContact("returning", 3);
        await insertContact("never-booked", 0);

        await runMigration();

        const { rows } = await getDb().execute(
          "SELECT contact_hash, visits, public_booking_count, admin_booking_count FROM contact_preferences ORDER BY contact_hash",
        );
        // A returning contact's prior orders surface as public bookings; a
        // contact with no visits stays at zero. Admin counts are never guessed.
        expect(rows).toEqual([
          {
            admin_booking_count: 0,
            contact_hash: "never-booked",
            public_booking_count: 0,
            visits: 0,
          },
          {
            admin_booking_count: 0,
            contact_hash: "returning",
            public_booking_count: 3,
            visits: 3,
          },
        ]);
      });
    });
  },
);
