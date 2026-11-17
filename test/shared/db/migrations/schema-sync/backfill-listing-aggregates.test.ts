import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import {
  backfillListingAggregates,
  schemaSqlIdentifiers,
} from "#db/migrations/schema-sync.ts";
import { sql, sqlName } from "#db/sql.ts";
import {
  columnNames,
  readListingAggregates,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/**
 * A database that predates `2026-06-24_attendees_kind` holds the listing
 * aggregate columns without `attendees.kind`, so the backfill picks its legacy
 * statement. The legacy statement counts a ticket for every line with a
 * quantity above zero, and it cannot read the kind column.
 */
describeWithEnv(
  "db > listing aggregate backfill before attendees.kind",
  {
    db: true,
    triggers: true,
  },
  () => {
    /** Drop every index and trigger that reads `kind`, then the column itself. */
    const removeKindColumn = async (): Promise<void> => {
      const sqliteObjects = await getDb().execute(
        sql`SELECT name, type, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL`,
      );
      for (const row of sqliteObjects.rows) {
        if (!schemaSqlIdentifiers(String(row.sql)).has("kind")) continue;
        const name = sqlName(String(row.name));
        await getDb().execute(
          String(row.type) === "index"
            ? sql`DROP INDEX IF EXISTS ${name}`
            : sql`DROP TRIGGER IF EXISTS ${name}`,
        );
      }
      await getDb().execute(sql`ALTER TABLE attendees DROP COLUMN kind`);
    };

    test("writes the aggregate counts without the kind column", async () => {
      // The drop takes the aggregate triggers with it, so the counts below
      // only come from the backfill.
      await removeKindColumn();
      expect(await columnNames("attendees")).not.toContain("kind");

      const listing = await createTestListing({ maxAttendees: 50 });
      await getDb().execute(
        sql`INSERT INTO listing_attendees (listing_id, attendee_id, quantity)
            VALUES (${listing.id}, 1, 3), (${listing.id}, 2, 2), (${listing.id}, 3, 0)`,
      );
      expect(await readListingAggregates(listing.id)).toEqual({
        booked_quantity: 0,
        tickets_count: 0,
      });

      await backfillListingAggregates();

      // The zero-quantity line holds capacity but is not a ticket.
      expect(await readListingAggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 2,
      });
    });
  },
);
