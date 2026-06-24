import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import dropListingAttendeeRefundedMigration from "#shared/db/migrations/2026-06-22_drop_listing_attendee_refunded.ts";
import { recreateTable } from "#shared/db/migrations/schema-sync.ts";
import {
  buildMigrationContext,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import {
  columnNames,
  seedPreDropLedgerColumns,
} from "../migration-test-helpers.ts";

// This migration's up() only recreates the table.
const context = buildMigrationContext({ recreateTable });

const runMigration = () => dropListingAttendeeRefundedMigration(context).up();

describeWithEnv(
  "db > migrations > 2026-06-22_drop_listing_attendee_refunded",
  { db: true, triggers: true },
  () => {
    test("drops the refunded column from listing_attendees", async () => {
      await seedPreDropLedgerColumns();
      expect(await columnNames("listing_attendees")).toContain("refunded");
      await runMigration();
      expect(await columnNames("listing_attendees")).not.toContain("refunded");
    });

    test("preserves the existing booking rows it rebuilds", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Refunded Row",
        "row@example.com",
      );
      // Reproduce a production row that still carried the (now-dropped) column.
      await seedPreDropLedgerColumns();
      await getDb().execute({
        args: [attendee.id],
        sql: "UPDATE listing_attendees SET refunded = 1 WHERE attendee_id = ?",
      });

      await runMigration();

      // The recreate rebuilds the table from SCHEMA (no refunded), but the
      // booking row itself — quantity, listing link — survives intact.
      const row = (
        await getDb().execute({
          args: [attendee.id],
          sql: "SELECT listing_id, quantity FROM listing_attendees WHERE attendee_id = ?",
        })
      ).rows[0]!;
      expect(Number(row.listing_id)).toBe(listing.id);
      expect(Number(row.quantity)).toBe(1);
    });
  },
);
