import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  getListingAggregateRecalculation,
  getListingWithCount,
  invalidateListingsCache,
  resetListingAggregateFields,
  updateListingAggregateValues,
} from "#shared/db/listings.ts";
import {
  LISTING_AGGREGATE_WRITE_COLUMNS,
  TRIGGERS,
} from "#shared/db/migrations/schema.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

describe("LISTING_AGGREGATE_WRITE_COLUMNS matches the trigger SQL", () => {
  test("the UPDATE trigger fires on exactly the columns in LISTING_AGGREGATE_WRITE_COLUMNS", () => {
    const updateTrigger = TRIGGERS.find(
      (t) => t.name === "trg_listing_attendees_aggregates_update",
    );
    expect(updateTrigger).toBeDefined();
    const expectedCols = [...LISTING_AGGREGATE_WRITE_COLUMNS].join(", ");
    expect(updateTrigger!.sql).toContain(
      `AFTER UPDATE OF ${expectedCols} ON listing_attendees`,
    );
  });
});

/**
 * The listings count columns (booked_quantity, tickets_count) are maintained by
 * triggers on listing_attendees. These tests drive the triggers directly with
 * raw INSERT/UPDATE/DELETE so the trigger SQL itself is the unit under test —
 * including the branches the higher-level booking flows don't hit: moving a row
 * between listings, and leaving the columns untouched when an unrelated column
 * changes.
 *
 * Income is no longer a trigger-maintained column: it is projected from the
 * transfers ledger (gross credits to revenue:<listingId>) at read time, so it is
 * exercised separately via posted ledger legs rather than via price_paid.
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
    };

    const aggregates = async (listingId: number): Promise<Aggregates> => {
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

    const insertAttendee = (
      listingId: number,
      attendeeId: number,
      quantity: number,
    ): Promise<unknown> =>
      getDb().execute({
        args: [listingId, attendeeId, quantity],
        sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, ?, ?)",
      });

    const incomeOf = async (listingId: number): Promise<number> => {
      invalidateListingsCache();
      return (await getListingWithCount(listingId))!.income;
    };

    test("a new listing starts with zeroed aggregates", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 0,
        tickets_count: 0,
      });
    });

    test("listingsTable read exposes the trigger-maintained counts", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      invalidateListingsCache();
      const reread = await getListingWithCount(listing.id);
      expect(reread).toMatchObject({
        attendee_count: 3,
        tickets_count: 1,
      });
    });

    test("insert increments quantity and ticket count", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      await insertAttendee(listing.id, 2, 2);
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 2,
      });
    });

    test("delete decrements the row's contribution", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      await insertAttendee(listing.id, 2, 2);
      await getDb().execute({
        args: [listing.id, 1],
        sql: "DELETE FROM listing_attendees WHERE listing_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 2,
        tickets_count: 1,
      });
    });

    test("updating quantity applies the delta", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      await getDb().execute({
        args: [listing.id, 1],
        sql: "UPDATE listing_attendees SET quantity = 5 WHERE listing_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 1,
      });
    });

    test("moving a row to another listing shifts its aggregates", async () => {
      const from = await createTestListing({ maxAttendees: 50 });
      const to = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(from.id, 1, 4);

      await getDb().execute({
        args: [to.id, from.id, 1],
        sql: "UPDATE listing_attendees SET listing_id = ? WHERE listing_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(from.id)).toEqual({
        booked_quantity: 0,
        tickets_count: 0,
      });
      expect(await aggregates(to.id)).toEqual({
        booked_quantity: 4,
        tickets_count: 1,
      });
    });

    test("updating an unrelated column leaves aggregates unchanged", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      const before = await aggregates(listing.id);

      // checked_in is not in the trigger's UPDATE OF list, so this must not fire.
      await getDb().execute({
        args: [listing.id, 1],
        sql: "UPDATE listing_attendees SET checked_in = 1 WHERE listing_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(listing.id)).toEqual(before);
    });

    test("income is projected from the ledger's gross revenue credits", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      // A raw attendee row with no ledger legs contributes nothing to income.
      await insertAttendee(listing.id, 1, 1);
      expect(await incomeOf(listing.id)).toBe(0);

      // A posted booking credits revenue:<listingId>, which the income subquery
      // sums — equalling the old SUM(price_paid) for the same paid booking.
      await postListingSale({ attendeeId: 1, gross: 1500, listingId: listing.id });
      expect(await incomeOf(listing.id)).toBe(1500);
    });

    test("a refund does not reduce a listing's gross income", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await postListingSale({ attendeeId: 7, gross: 4000, listingId: listing.id });
      expect(await incomeOf(listing.id)).toBe(4000);

      // The refund reversal posts a SOURCE-side leg on revenue:<listingId>, so the
      // gross dest-credits the income reads are unchanged (it tracks gross, not net,
      // matching what admins currently see).
      await recordAttendeeRefund(7);
      expect(await incomeOf(listing.id)).toBe(4000);
    });

    test("manual aggregate edits override the trigger-maintained values", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);

      await updateListingAggregateValues(listing.id, {
        booked_quantity: 8,
        tickets_count: 4,
      });

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 8,
        tickets_count: 4,
      });
    });

    test("selected aggregate reset fields are rebuilt from attendee rows", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      await insertAttendee(listing.id, 2, 2);
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 8,
        tickets_count: 4,
      });

      const stale = (await getListingWithCount(listing.id))!;
      expect(await getListingAggregateRecalculation(stale)).toEqual({
        booked_quantity: { current: 8, recalculated: 5 },
        tickets_count: { current: 4, recalculated: 2 },
      });

      await resetListingAggregateFields(listing.id, ["booked_quantity"]);

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 4,
      });
    });

    test("the migration's backfill recomputes stale aggregates from scratch", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await insertAttendee(listing.id, 1, 3);
      await insertAttendee(listing.id, 2, 2);

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
        "UPDATE listings SET booked_quantity = 999, tickets_count = 999",
      );

      // Re-running up() recreates the triggers and recomputes the absolute totals.
      await migration.up();

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 2,
      });
    });
  },
);
