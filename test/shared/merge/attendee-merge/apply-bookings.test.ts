/** Booking-row behavior for attendee merges. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookingChoice,
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
    const copiedLineCases = [
      {
        copied: { checkedIn: 0, quantity: 0 },
        name: "clears check-in when copying a no-quantity source line",
        sourceLine: { checkedIn: 1, quantity: 0 },
      },
      {
        copied: { checkedIn: 1, quantity: 1 },
        name: "preserves check-in when copying a positive-quantity source line",
        sourceLine: { checkedIn: 1, quantity: 1 },
      },
    ];

    for (const { copied, name, sourceLine } of copiedLineCases) {
      test(name, async () => {
        const { listing2, source, target } = await createMergePair();
        await getDb().execute(
          sql`UPDATE listing_attendees
                 SET checked_in = ${sourceLine.checkedIn}, quantity = ${sourceLine.quantity}
               WHERE attendee_id = ${source.id}`,
        );

        const moved = await runMergeAndGetMovedBooking(
          source,
          target,
          listing2.id,
        );

        expect({
          checkedIn: moved.checked_in,
          quantity: moved.quantity,
        }).toEqual(copied);
      });
    }

    const sameListingCases = [
      {
        choose: "keep_target",
        conflictClass: "duplicate",
        expectedQuantity: 1,
        name: "keeps the target booking when requested",
        replacedTarget: 0,
        skipped: 1,
        sourceQuantity: 1,
      },
      {
        choose: "take_source",
        conflictClass: "conflicting_metadata",
        expectedQuantity: 5,
        name: "replaces the target booking with the source booking when requested",
        replacedTarget: 1,
        skipped: 0,
        sourceQuantity: 5,
      },
    ] as const;

    for (const bookingCase of sameListingCases) {
      test(bookingCase.name, async () => {
        const { listing, target, source } = await createMergePair({
          sameListing: true,
        });
        await getDb().execute(
          sql`UPDATE listing_attendees SET quantity = ${bookingCase.sourceQuantity} WHERE attendee_id = ${source.id}`,
        );
        const key = bookingKey(listing.id, null, 0, 0);

        const { diff, result } = await runMerge({
          decide: bookingChoice(key, bookingCase.choose),
          source,
          target,
        });

        expect(
          diff.bookingItems.map(({ conflictClass: kind }) => kind),
        ).toEqual([bookingCase.conflictClass]);
        expect(result).toEqual({
          success: true,
          summary: {
            answersCleared: 0,
            answersKept: 0,
            answersTakenFromSource: 0,
            bookingsCredited: 0,
            bookingsMoved: 0,
            bookingsReplacedTarget: bookingCase.replacedTarget,
            bookingsSkipped: bookingCase.skipped,
            bookingsWrittenOff: 0,
            piiFieldsFromSource: [],
          },
        });
        expect(
          await queryAll<{ listing_id: number; quantity: number }>(
            sql`SELECT listing_id, quantity
                  FROM listing_attendees
                 WHERE attendee_id = ${target.id}
                   AND listing_id = ${listing.id}`,
          ),
        ).toEqual([
          { listing_id: listing.id, quantity: bookingCase.expectedQuantity },
        ]);
      });
    }
  });
});
