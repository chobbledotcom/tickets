import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { listingIncomeDropFixture } from "#test-utils/db/legacy-aggregate-migration.ts";
import {
  readListingAggregates as listingAggregates,
  runAggregateColumnDropTests,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const { contribution, runMigration } = listingIncomeDropFixture;

describeWithEnv(
  "db > migrations > 2026-06-22_drop_listing_income",
  { db: true, triggers: true },
  () => {
    runAggregateColumnDropTests({
      contribution,
      createSubject: () => createTestListing({ maxAttendees: 50 }),
      dropColumn: "income",
      dropColumnPhrase: "an income",
      expected: { booked_quantity: 3, tickets_count: 1 },
      insertUsage: (listingId) =>
        getDb().execute(
          sql`INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (${listingId}, 1, 3)`,
        ),
      readAggregates: listingAggregates,
      runMigration,
      targetTable: "listings",
      triggerStem: "trg_listing_attendees_aggregates",
      updateOfColumns: ["quantity", "price_paid", "listing_id"],
      usageTable: "listing_attendees",
    });
  },
);
