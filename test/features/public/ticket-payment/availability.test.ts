import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkAvailability } from "#routes/public/ticket-payment.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const ticketListingFor = async (listingId: number) => {
  const listing = await getListingWithCount(listingId);
  if (listing === null) throw new Error("Test listing not found");
  return buildTicketListing(listing, false, undefined);
};

describeWithEnv("ticket payment availability", { db: true }, () => {
  test("an omitted date checks a daily listing's total capacity", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 2 });
    await bookAttendee(listing, { date: "2026-05-01", quantity: 2 });
    const ticketListing = await ticketListingFor(listing.id);
    const quantities = new Map([[listing.id, 1]]);

    expect(await checkAvailability([ticketListing], quantities)).toBe(false);
    expect(
      await checkAvailability([ticketListing], quantities, "2026-05-02"),
    ).toBe(true);
  });

  test("persisted bookings change an available selection to unavailable", async () => {
    const listing = await createTestListing({ maxAttendees: 2 });
    const ticketListing = await ticketListingFor(listing.id);
    const quantities = new Map([[listing.id, 2]]);

    expect(await checkAvailability([ticketListing], quantities, null)).toBe(
      true,
    );
    await bookAttendee(listing, { quantity: 1 });
    expect(await checkAvailability([ticketListing], quantities, null)).toBe(
      false,
    );
  });
});
