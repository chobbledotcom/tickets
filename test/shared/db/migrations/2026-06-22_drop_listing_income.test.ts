import { getDb } from "#db/client.ts";
import dropListingIncomeMigration from "#db/migrations/2026-06-22_drop_listing_income.ts";
import { recreateTable, syncTriggers } from "#db/migrations/schema-sync.ts";
import { type SqlStatement, sql, sqlName } from "#db/sql.ts";
import {
  readListingAggregates as listingAggregates,
  runAggregateColumnDropTests,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

// This migration's up() touches only the three below — recreateTable and
// syncTriggers do the trigger/structure rebuild; getDb is real by default.
const context = buildMigrationContext({ recreateTable, syncTriggers });

const runMigration = () => dropListingIncomeMigration(context).up();

/** Old income-maintaining SET clause (signed `+`/`-`) the pre-drop triggers used,
 *  so the fixture mirrors a real pre-migration database whose triggers still
 *  reference the income column. */
const contribution = (sign: "+" | "-", row: "NEW" | "OLD"): SqlStatement => {
  const op = sign === "+" ? sql`+` : sql`-`;
  return sql`UPDATE listings SET
     booked_quantity = booked_quantity ${op} ${sqlName(`${row}.quantity`)},
     tickets_count = tickets_count ${op} 1,
     income = income ${op} ${sqlName(`${row}.price_paid`)}
   WHERE id = ${sqlName(`${row}.listing_id`)};`;
};

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
