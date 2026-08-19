/** Booking-row behavior for attendee merges. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#db/client.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookingChoice,
  createAttendee,
  createMergePair,
  getBookings,
  pii,
  runMerge,
} from "./helpers.ts";

type MergePair = Awaited<ReturnType<typeof createMergePair>>;

const runMergeAndGetMovedBooking = async (
  source: MergePair["source"],
  target: MergePair["target"],
  sourceListingId: number,
) => {
  const { result } = await runMerge({
    source,
    sourcePii: pii("Bob", "b@test.com"),
    target,
    targetPii: pii("Alice", "a@test.com"),
  });
  expect(result.success).toBe(true);
  const moved = (await getBookings(target.id)).filter(
    ({ listing_id }) => listing_id === sourceListingId,
  );
  expect(moved.length).toBe(1);
  return moved[0]!;
};

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("applyAttendeeMerge bookings", () => {
    test("clears check-in when copying a no-quantity source line", async () => {
      const targetListing = await createTestListing({ maxAttendees: 10 });
      const sourceListing = await createTestListing({ maxAttendees: 10 });
      const target = await createAttendee(
        targetListing.id,
        "Alice",
        "a@test.com",
      );
      const source = await createAttendee(
        sourceListing.id,
        "Bob",
        "b@test.com",
      );
      await getDb().execute({
        args: [source.id],
        sql: "UPDATE listing_attendees SET quantity = 0, checked_in = 1 WHERE attendee_id = ?",
      });

      const moved = await runMergeAndGetMovedBooking(
        source,
        target,
        sourceListing.id,
      );

      expect({ checkedIn: moved.checked_in, quantity: moved.quantity }).toEqual(
        {
          checkedIn: 0,
          quantity: 0,
        },
      );
    });

    test("preserves check-in when copying a positive-quantity source line", async () => {
      const { listing2, source, target } = await createMergePair();
      await getDb().execute({
        args: [source.id],
        sql: "UPDATE listing_attendees SET checked_in = 1 WHERE attendee_id = ?",
      });

      const moved = await runMergeAndGetMovedBooking(
        source,
        target,
        listing2.id,
      );

      expect({ checkedIn: moved.checked_in, quantity: moved.quantity }).toEqual(
        {
          checkedIn: 1,
          quantity: 1,
        },
      );
    });

    test("keeps the target booking when requested", async () => {
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });
      const key = bookingKey(listing.id, null, 0, 0);

      const { diff, result } = await runMerge({
        decide: bookingChoice(key, "keep_target"),
        source,
        target,
      });

      expect(
        diff.bookingItems.map(({ conflictClass }) => conflictClass),
      ).toEqual(["duplicate"]);
      expect(result).toEqual({
        success: true,
        summary: {
          answersCleared: 0,
          answersKept: 0,
          answersTakenFromSource: 0,
          bookingsCredited: 0,
          bookingsMoved: 0,
          bookingsReplacedTarget: 0,
          bookingsSkipped: 1,
          bookingsWrittenOff: 0,
          piiFieldsFromSource: [],
        },
      });
      expect(
        await queryAll<{ listing_id: number }>(
          "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
          [target.id],
        ),
      ).toEqual([{ listing_id: listing.id }]);
    });

    test("replaces the target booking with the source booking when requested", async () => {
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });
      await getDb().execute({
        args: [source.id],
        sql: "UPDATE listing_attendees SET quantity = 5 WHERE attendee_id = ?",
      });
      const key = bookingKey(listing.id, null, 0, 0);

      const { diff, result } = await runMerge({
        decide: bookingChoice(key, "take_source"),
        source,
        target,
      });

      expect(
        diff.bookingItems.map(({ conflictClass }) => conflictClass),
      ).toEqual(["conflicting_metadata"]);
      expect(result).toEqual({
        success: true,
        summary: {
          answersCleared: 0,
          answersKept: 0,
          answersTakenFromSource: 0,
          bookingsCredited: 0,
          bookingsMoved: 0,
          bookingsReplacedTarget: 1,
          bookingsSkipped: 0,
          bookingsWrittenOff: 0,
          piiFieldsFromSource: [],
        },
      });
      expect(
        await queryAll<{ quantity: number }>(
          `SELECT quantity
             FROM listing_attendees
            WHERE attendee_id = ?
              AND listing_id = ?`,
          [target.id, listing.id],
        ),
      ).toEqual([{ quantity: 5 }]);
    });
  });
});
