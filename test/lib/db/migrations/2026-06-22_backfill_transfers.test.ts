import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import backfillTransfersMigration from "#shared/db/migrations/2026-06-22_backfill_transfers.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import {
  buildMigrationContext,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import {
  seedPreDropLedgerColumns,
  stampHistoricalPricePaid,
} from "../migration-test-helpers.ts";

// The backfill up() touches none of the schema-sync members; only the schema
// bookkeeping it can reach via `applySchemaChanges`/`syncIndexes` is live.
const context = buildMigrationContext({ applySchemaChanges, syncIndexes });

const runMigration = () => backfillTransfersMigration(context).up();

describeWithEnv(
  "db > migrations > 2026-06-22_backfill_transfers",
  { db: true },
  () => {
    // The backfill reads listing_attendees.refunded, dropped by the later
    // 2026-06-22_drop_listing_attendee_refunded migration; restore it so each
    // test exercises the pre-drop schema the backfill runs against in production.
    beforeEach(seedPreDropLedgerColumns);

    test("posts the ledger for an existing paid booking in the site currency", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const result = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, pricePaid: 4200 }],
        email: "a@b.c",
        name: "Historical",
      });
      if (!result.success) throw new Error(`setup failed: ${result.reason}`);
      const attendee = result.attendees[0]!;
      // A pre-ledger row carried its amount in price_paid (the backfill's source);
      // createAttendeeAtomic no longer writes it, so stamp the restored column.
      await stampHistoricalPricePaid(attendee.id, listing.id, 4200);
      expect((await allTransfers()).length).toBe(0); // pre-dual-write booking

      await runMigration();

      expect(await accountBalance(revenueAccount(listing.id))).toBe(4200);
      expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
    });

    test("is a no-op on a database with no paid bookings", async () => {
      await runMigration();
      expect((await allTransfers()).length).toBe(0);
    });
  },
);
