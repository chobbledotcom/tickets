import { getDb } from "#shared/db/client.ts";
import dropListingIncomeMigration from "#shared/db/migrations/2026-06-22_drop_listing_income.ts";
import {
  recreateTable,
  syncTriggers,
} from "#shared/db/migrations/schema-sync.ts";
import {
  buildMigrationContext,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import { runAggregateColumnDropTests } from "../migration-test-helpers.ts";

// This migration's up() touches only the three below — recreateTable and
// syncTriggers do the trigger/structure rebuild; getDb is real by default.
const context = buildMigrationContext({ recreateTable, syncTriggers });

const runMigration = () => dropListingIncomeMigration(context).up();

/** Old income-maintaining SET clause (signed `+`/`-`) the pre-drop triggers used,
 *  so the fixture mirrors a real pre-migration database whose triggers still
 *  reference the income column. */
const contribution = (sign: "+" | "-", row: "NEW" | "OLD"): string =>
  `UPDATE listings SET
     booked_quantity = booked_quantity ${sign} ${row}.quantity,
     tickets_count = tickets_count ${sign} 1,
     income = income ${sign} ${row}.price_paid
   WHERE id = ${row}.listing_id;`;

const listingAggregates = async (
  listingId: number,
): Promise<Record<string, number>> => {
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
    runAggregateColumnDropTests({
      contribution,
      createSubject: () => createTestListing({ maxAttendees: 50 }),
      dropColumn: "income",
      dropColumnPhrase: "an income",
      expected: { booked_quantity: 3, tickets_count: 1 },
      insertUsage: (listingId) =>
        getDb().execute({
          args: [listingId],
          sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, 1, 3)",
        }),
      readAggregates: listingAggregates,
      runMigration,
      targetTable: "listings",
      triggerStem: "trg_listing_attendees_aggregates",
      updateOfColumns: ["quantity", "price_paid", "listing_id"],
      usageTable: "listing_attendees",
    });
  },
);
