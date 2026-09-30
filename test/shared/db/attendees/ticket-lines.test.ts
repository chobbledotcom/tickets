import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { pairKey } from "#booking/ticket-moves.ts";
import { getPairBookings } from "#db/attendees/ticket-lines.ts";
import { executeUpdate } from "#db/client.ts";
import { bookRefundedSibling } from "#test-utils/attendees/refunded-sibling.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > pair bookings", { db: true }, () => {
  test("reads each pair's ticket lines on its own listing", async () => {
    const gala = await createTestListing({ maxAttendees: 10, maxQuantity: 5 });
    const workshop = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 5,
    });
    const ada = await createMultiBookingAttendee("Ada", "ada@example.com", [
      { listingId: gala.id, quantity: 3 },
      { listingId: workshop.id, quantity: 2 },
    ]);
    await executeUpdate(
      "listing_attendees",
      { checked_in: 1 },
      { attendee_id: ada.id, listing_id: gala.id },
    );

    const bookings = await getPairBookings([
      { attendeeId: ada.id, listingId: gala.id },
      { attendeeId: ada.id, listingId: workshop.id },
    ]);
    expect([...bookings]).toEqual([
      [pairKey(ada.id, gala.id), { checked_in: 1, quantity: 3 }],
      [pairKey(ada.id, workshop.id), { checked_in: 0, quantity: 2 }],
    ]);
  });

  test("leaves a refunded line out of the booking", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 5,
    });
    const group = await createTestGroup({ isPackage: true, name: "Kit" });
    const cara = await bookRefundedSibling(
      listing.id,
      group.id,
      "Cara",
      "cara@example.com",
    );

    const bookings = await getPairBookings([
      { attendeeId: cara.id, listingId: listing.id },
    ]);
    expect(bookings.get(pairKey(cara.id, listing.id))).toEqual({
      checked_in: 0,
      quantity: 1,
    });
  });

  test("reads nothing for no pairs", async () => {
    expect(await getPairBookings([])).toEqual(new Map());
  });
});
