import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getDb } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
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
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [{ date: "2026-09-20", listingId: listing.id, pricePaid: 500 }],
    email: "ambiguous@example.com",
    name: "Ambiguous",
  });
  if (!made.success) throw new Error("booking setup failed");
  const attendeeId = made.attendees[0]!.id;
  await getDb().execute({
    args: [attendeeId, listing.id],
    sql:
      "INSERT INTO listing_attendees (attendee_id, listing_id, start_at)" +
      " VALUES (?, ?, '2026-09-21T00:00:00Z')",
  });
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
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "no-order@example.com",
      name: "No Order",
    });
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;

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
