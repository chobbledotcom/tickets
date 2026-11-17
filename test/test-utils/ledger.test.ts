import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeId } from "#test-utils/db-helpers/attendee-booking.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale, refundBookedOrder } from "#test-utils/ledger.ts";

/** One attendee holding two stamped orders on the same listing, the shape a
 *  merge leaves behind. */
const attendeeHoldingTwoOrdersOnOneListing = async (): Promise<{
  attendeeId: number;
  listingId: number;
}> => {
  const listing = await createDailyTestListing();
  const attendeeId = await bookTestAttendeeId(
    [{ date: "2026-09-20", listingId: listing.id, pricePaid: 500 }],
    "Ambiguous",
  );
  await getDb().execute(
    sql`INSERT INTO listing_attendees (attendee_id, listing_id, start_at) VALUES (${attendeeId}, ${listing.id}, '2026-09-21T00:00:00Z')`,
  );
  await postListingSale({
    attendeeId,
    eventId: "ambiguous-one",
    gross: 500,
    listingId: listing.id,
    stampStartAt: "2026-09-20T00:00:00Z",
  });
  await postListingSale({
    attendeeId,
    eventId: "ambiguous-two",
    gross: 500,
    listingId: listing.id,
    stampStartAt: "2026-09-21T00:00:00Z",
  });
  return { attendeeId, listingId: listing.id };
};

describeWithEnv("test-utils ledger helpers", { db: true }, () => {
  test("refundBookedOrder names the missing order when the row carries none", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendeeId = await bookTestAttendeeId(
      [{ listingId: listing.id, quantity: 1 }],
      "No Order",
    );

    await expect(refundBookedOrder(attendeeId, listing.id)).rejects.toThrow(
      `Attendee ${attendeeId} has no booked order on listing ${listing.id} to refund`,
    );
  });

  test("refundBookedOrder refuses to guess between two orders on one listing", async () => {
    const { attendeeId, listingId } =
      await attendeeHoldingTwoOrdersOnOneListing();

    await expect(refundBookedOrder(attendeeId, listingId)).rejects.toThrow(
      `Attendee ${attendeeId} holds more than one order on listing ${listingId}` +
        " — reverse the event group you mean, not a guessed one",
    );
  });
});
