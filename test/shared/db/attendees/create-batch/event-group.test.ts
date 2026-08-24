import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createBookingAtomic } from "#db/attendees/create.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  buildPlan,
  expectBookingOk,
  pricedLine,
  storedEventGroup,
} from "#test-utils/db-helpers/attendee-creation.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > batch event group", { db: true }, () => {
  test("stamps the only ledger leg's event group", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 500,
    });
    const { plan } = await buildPlan({
      eventId: "single-leg-event",
      fullSubtotal: 500,
      lines: [pricedLine(listing.id, 500, 1)],
      total: 0,
    });
    expect(plan.legs).toHaveLength(1);

    const result = expectBookingOk(
      await createBookingAtomic(
        {
          bookings: [{ listingId: listing.id, pricePaid: 0, quantity: 1 }],
          email: "owed@example.com",
          name: "Owed",
        },
        plan,
      ),
    );

    expect(await storedEventGroup(result.attendees[0]!.id)).toBe(
      plan.legs[0]!.eventGroup,
    );
  });
});
