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
  tableExists,
} from "#shared/db/migrations/schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

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
  tableExists,
  verifyCurrentAppSchema: unused,
  verifyRequirement: (_req: SchemaRequirement) => async () => {},
};

const runMigration = () => backfillTransfersMigration(context).up();

describeWithEnv(
  "db > migrations > 2026-06-22_backfill_transfers",
  { db: true },
  () => {
    test("backfills the ledger from existing paid bookings", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const result = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, pricePaid: 5000 }],
        email: "a@b.c",
        name: "Historical",
      });
      if (!result.success) throw new Error(`setup failed: ${result.reason}`);
      const attendee = result.attendees[0]!;
      expect((await allTransfers()).length).toBe(0);

      await runMigration();

      // Currency resolves to GBP (the test site's country is GB) and the paid
      // booking nets to zero with its revenue recognised.
      expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
      expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
    });
  },
);
