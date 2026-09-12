/**
 * The refunded projection against a real ledger, where each person holds
 * orders on DIFFERENT listings: `select.test.ts` pins the SQL this builder
 * emits; these pin what that SQL ANSWERS once a partial reversal exists, which
 * is the case a string test cannot see. A booking whose own money is still
 * with the provider must not read as refunded because a DIFFERENT booking of
 * the same person came back — the scanner and check-in both turn people away
 * on this flag.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  bookTwoListings,
  PRICE,
  refundedOn,
  reverseOrderFor,
} from "./support.ts";

describeWithEnv(
  "db > attendees > refunded between separate orders",
  { db: true },
  () => {
    describe("one order reversed, another still paid", () => {
      test("the reversed booking reads refunded", async () => {
        const { attendeeId, cameBack } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);

        expect(await refundedOn(cameBack, attendeeId)).toBe(1);
      });

      // A reversal leg only names the order it undid, so an order whose
      // provider charge was never returned keeps reading paid.
      test("the booking still with the provider does not", async () => {
        const { attendeeId, cameBack, stillPaid } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);

        expect(await refundedOn(stillPaid, attendeeId)).toBe(0);
      });

      // A free booking has no sale leg, like a placeholder — but no money
      // either, so it must never read another listing's returned cash.
      test("a free booking beside a refunded one is not refunded", async () => {
        const free = await createTestListing({
          maxAttendees: 10,
          unitPrice: 0,
        });
        const paid = await createPaidListing({ name: "Paid" });
        const made = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { listingId: free.id, pricePaid: 0 },
            { listingId: paid.id, pricePaid: PRICE },
          ],
          email: "mixed@example.com",
          name: "Free And Paid",
        });
        if (!made.success) throw new Error("booking setup failed");
        const attendeeId = made.attendees[0]!.id;
        await postListingSale({ attendeeId, gross: PRICE, listingId: paid.id });

        await reverseOrderFor(attendeeId, paid.id);

        expect(await refundedOn(paid.id, attendeeId)).toBe(1);
        expect(await refundedOn(free.id, attendeeId)).toBe(0);
      });

      test("reversing both leaves neither booking paid", async () => {
        const { attendeeId, cameBack, stillPaid } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);
        await reverseOrderFor(attendeeId, stillPaid);

        expect(await refundedOn(cameBack, attendeeId)).toBe(1);
        expect(await refundedOn(stillPaid, attendeeId)).toBe(1);
      });
    });
  },
);
