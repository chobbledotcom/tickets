import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import backfillTransfersMigration from "#shared/db/migrations/2026-06-22_backfill_transfers.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

// Promise<never> so one stub satisfies both the void- and boolean-returning
// context members; the backfill up() touches none of them.
const unused = async (): Promise<never> => {
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
  tableExists: unused,
  verifyCurrentAppSchema: unused,
  verifyRequirement: (_req: SchemaRequirement) => async () => {},
};

const runMigration = () => backfillTransfersMigration(context).up();

describeWithEnv(
  "db > migrations > 2026-06-22_backfill_transfers",
  { db: true },
  () => {
    test("posts the ledger for an existing paid booking in the site currency", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const result = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, pricePaid: 4200 }],
        email: "a@b.c",
        name: "Historical",
      });
      if (!result.success) throw new Error(`setup failed: ${result.reason}`);
      const attendee = result.attendees[0]!;
      expect((await allTransfers()).length).toBe(0); // pre-dual-write booking

      await runMigration();

      expect(await accountBalance(revenueAccount(listing.id))).toBe(4200);
      expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
      // Site currency defaults to GBP when COUNTRY is unset.
      expect((await allTransfers())[0]!.currency).toBe("GBP");
    });

    test("is a no-op on a database with no paid bookings", async () => {
      await runMigration();
      expect((await allTransfers()).length).toBe(0);
    });
  },
);
