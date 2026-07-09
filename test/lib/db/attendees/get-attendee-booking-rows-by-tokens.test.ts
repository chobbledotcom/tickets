import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeBookingRowsByTokens } from "#shared/db/attendees.ts";
import { describeWithEnv } from "#test-utils";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "db > attendees > getAttendeeBookingRowsByTokens",
  {
    db: true,
  },
  () => {
    test("returns an empty list for no tokens", async () => {
      expect(await getAttendeeBookingRowsByTokens([])).toEqual([]);
    });

    test("resolves tokens to booking rows without returning PII", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Narrow",
      });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "Narrow Person",
        "narrow@example.com",
      );

      const rows = await getAttendeeBookingRowsByTokens([token]);
      expect(rows[0]?.id).toBe(attendee.id);
      expect(rows[0]?.bookings.map((line) => line.listing_id)).toEqual([
        listing.id,
      ]);
      expect(Object.keys(rows[0]!.bookings[0]!).sort()).toEqual([
        "listing_id",
        "price_paid",
        "quantity",
      ]);
      expect("pii_blob" in rows[0]!).toBe(false);
    });

    test("drops no-quantity lines from resolved bookings", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "No Qty",
      });
      const { token } = await createTestAttendeeDirect(
        listing.id,
        "No Qty",
        "noqty@example.com",
        0,
      );

      const rows = await getAttendeeBookingRowsByTokens([token]);
      expect(rows[0]?.bookings).toEqual([]);
    });
  },
);
