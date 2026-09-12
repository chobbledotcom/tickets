/**
 * The failure arms of `support.ts` — a helper that finds nothing must name
 * what it looked for, so a mis-wired test fails loudly here instead of
 * asserting against a value it never seeded.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookTwoListings,
  DAYS,
  orderWithPaidLinesAndAFreeMember,
  refundedOn,
  reverseOrderFor,
  reverseOrderGroup,
} from "./support.ts";

describeWithEnv(
  "db > attendees > refunded support helpers",
  { db: true },
  () => {
    test("names the listing a person holds no order on", async () => {
      const { attendeeId } = await bookTwoListings();
      const notBooked = await createPaidListing({ name: "Not booked" });

      await expect(reverseOrderFor(attendeeId, notBooked.id)).rejects.toThrow(
        `No order found for listing ${notBooked.id}`,
      );
    });

    test("names the group a person holds no order under", async () => {
      const { attendeeId } = await bookTwoListings();

      await expect(
        reverseOrderGroup(attendeeId, "evt-never-booked"),
      ).rejects.toThrow("No order found for group evt-never-booked");
    });

    test("names the listing a person holds no row on", async () => {
      const { attendeeId, cameBack } = await bookTwoListings();
      const stranger = attendeeId + 1;

      await expect(refundedOn(cameBack, stranger)).rejects.toThrow(
        `Attendee ${stranger} has no row on listing ${cameBack}`,
      );
      await expect(refundedOn(cameBack, stranger, DAYS[0])).rejects.toThrow(
        `Attendee ${stranger} has no row on listing ${cameBack} on ${DAYS[0]}`,
      );
    });

    test("a refused booking fails the seeding loudly", async () => {
      const full = await createTestListing({
        maxAttendees: 1,
        unitPrice: 500,
      });
      const filled = await attendeesApi.createAttendeeAtomic({
        bookings: [{ listingId: full.id, pricePaid: 500 }],
        email: "fills-the-listing@example.com",
        name: "Filler",
      });
      if (!filled.success) throw new Error("fill setup failed");

      await expect(
        orderWithPaidLinesAndAFreeMember(
          [full.id],
          "over-capacity@example.com",
        ),
      ).rejects.toThrow("booking setup failed");
    });
  },
);
