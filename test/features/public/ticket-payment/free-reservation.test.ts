import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createFreeReservation } from "#routes/public/ticket-payment.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("free reservation defaults", { db: true }, () => {
  test("uses one day, no balance, and no ledger legs when only stock is consumed", async () => {
    const listing = testListingWithCount({ id: 7 });
    using create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve({
        attendees: [{ id: 1, listing_id: 7, ticket_token: "ticket-token" }],
        success: true,
      } as never),
    );

    const result = await createFreeReservation({
      contact: {
        address: "",
        email: "buyer@example.com",
        name: "Buyer",
        phone: "",
        special_instructions: "",
      },
      date: null,
      items: [
        {
          listingId: listing.id,
          name: listing.name,
          quantity: 1,
          slug: listing.slug,
          unitPrice: 0,
        },
      ],
      ledgerOrder: null,
      listings: [buildTicketListing(listing, false, undefined)],
      modifierUsages: [{ amountApplied: 0, modifierId: 1, quantity: 1 }],
    });

    expect(result).toMatchObject({ success: true, token: "ticket-token" });
    expect(create.calls[0]!.args[0]).toMatchObject({
      bookings: [
        {
          date: null,
          durationDays: 1,
          listingId: 7,
          packageGroupId: 0,
          quantity: 1,
        },
      ],
      remainingBalance: 0,
    });
    expect(create.calls[0]!.args[1].legs).toEqual([]);
  });
});
