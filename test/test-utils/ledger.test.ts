import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { refundBookedOrder } from "#test-utils/ledger.ts";

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
});
