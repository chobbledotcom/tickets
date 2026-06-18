import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/**
 * The listings aggregate columns (booked_quantity, tickets_count, income) are
 * maintained by triggers on listing_attendees. These tests drive the triggers
 * directly with raw INSERT/UPDATE/DELETE so the trigger SQL itself is the unit
 * under test — including the branches the higher-level booking flows don't hit:
 * moving a row between listings, and leaving the columns untouched when an
 * unrelated column changes.
 */
describeWithEnv(
  "db > listings aggregate triggers",
  {
    db: true,
    triggers: true,
  },
  () => {
    type Aggregates = {
      booked_quantity: number;
      tickets_count: number;
      income: number;
    };

    const aggregates = async (listingId: number): Promise<Aggregates> => {
      const result = await getDb().execute({
        args: [listingId],
        sql: "SELECT booked_quantity, tickets_count, income FROM listings WHERE id = ?",
      });
      const row = result.rows[0]!;
      return {
        booked_quantity: Number(row.booked_quantity),
        income: Number(row.income),
        tickets_count: Number(row.tickets_count),
      };
    };

    const insertAttendee = (
      listingId: number,
      attendeeId: number,
      quantity: number,
      pricePaid: number,
    ): Promise<unknown> =>
      getDb().execute({
        args: [listingId, attendeeId, quantity, pricePaid],
        sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity, price_paid) VALUES (?, ?, ?, ?)",
      });

    test("a new listing starts with zeroed aggregates", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 0,
        income: 0,
        tickets_count: 0,
      });
    });

    test("insert increments quantity, ticket count and income", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3, 1500);
      await insertAttendee(listing.id, 2, 2, 1000);
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        income: 2500,
        tickets_count: 2,
      });
    });

    test("delete decrements the row's contribution", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3, 1500);
      await insertAttendee(listing.id, 2, 2, 1000);
      await getDb().execute({
        args: [listing.id, 1],
        sql: "DELETE FROM listing_attendees WHERE listing_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 2,
        income: 1000,
        tickets_count: 1,
      });
    });

    test("updating quantity and price_paid applies the delta", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3, 1500);
      await getDb().execute({
        args: [listing.id, 1],
        sql: "UPDATE listing_attendees SET quantity = 5, price_paid = 4000 WHERE listing_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        income: 4000,
        tickets_count: 1,
      });
    });

    test("moving a row to another listing shifts its aggregates", async () => {
      const from = await createTestListing({ maxAttendees: 50 });
      const to = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(from.id, 1, 4, 2000);

      await getDb().execute({
        args: [to.id, from.id, 1],
        sql: "UPDATE listing_attendees SET listing_id = ? WHERE listing_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(from.id)).toEqual({
        booked_quantity: 0,
        income: 0,
        tickets_count: 0,
      });
      expect(await aggregates(to.id)).toEqual({
        booked_quantity: 4,
        income: 2000,
        tickets_count: 1,
      });
    });

    test("updating an unrelated column leaves aggregates unchanged", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3, 1500);
      const before = await aggregates(listing.id);

      // checked_in is not in the trigger's UPDATE OF list, so this must not fire.
      await getDb().execute({
        args: [listing.id, 1],
        sql: "UPDATE listing_attendees SET checked_in = 1 WHERE listing_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(listing.id)).toEqual(before);
    });

    test("the migration's backfill recomputes stale aggregates from scratch", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3, 1500);
      await insertAttendee(listing.id, 2, 2, 1000);

      // Reproduce a pre-trigger state: drop the triggers, then corrupt the
      // columns directly (no trigger fires to correct them).
      const migration = MIGRATIONS.find(
        (m) => m.id === "2026-06-16_listing_aggregates",
      )!;
      await getDb().batch(
        [
          "DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_insert",
          "DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_delete",
          "DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_update",
        ],
        "write",
      );
      await getDb().execute(
        "UPDATE listings SET booked_quantity = 999, tickets_count = 999, income = 999",
      );

      // Re-running up() recreates the triggers and recomputes the absolute totals.
      await migration.up();

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        income: 2500,
        tickets_count: 2,
      });
    });
  },
);
