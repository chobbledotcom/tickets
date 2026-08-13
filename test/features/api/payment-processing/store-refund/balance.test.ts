import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settleBalanceSession } from "#routes/api/payment-processing/store-refund.ts";
import { processBooking } from "#shared/booking.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "settling a booking's outstanding balance",
  { db: true },
  () => {
    /** A reservation that still owes money, and the balance checkout for it. */
    const owing = async (owed: number) => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: owed,
      });
      const result = await processBooking(
        listing,
        {
          address: "",
          email: "owes@example.com",
          name: "Owes Money",
          phone: "",
          special_instructions: "",
        },
        1,
        null,
        "http://localhost",
      );
      if (result.type !== "success") throw new Error("booking failed");
      return { attendee: result.attendee, listing };
    };

    const settleFor = async (
      sessionId: string,
      attendeeId: number,
      listingId: number,
      amount: number,
    ) => {
      const intent = bookingIntent([{ e: listingId, p: amount, q: 1 }], {
        balanceAttendeeId: attendeeId,
      });
      const session = paymentSession(sessionId, amount, intent);
      return await settleBalanceSession(sessionId, session, intent);
    };

    describe("when the balance changed while they were paying", () => {
      test("does not settle for the wrong figure", async () => {
        const { attendee, listing } = await owing(1500);
        // The checkout was made for a balance that no longer stands.
        const result = await settleFor(
          "cs_stale",
          attendee.id,
          listing.id,
          900,
        );
        expect(result.success).toBe(false);
      });

      test("tells the customer the balance changed", async () => {
        const { attendee, listing } = await owing(1500);
        const result = await settleFor(
          "cs_stale_msg",
          attendee.id,
          listing.id,
          900,
        );
        expect((result as { error: string }).error).toBe(
          "The outstanding balance for this booking changed while you were paying.",
        );
      });

      test("asks the provider to try again later rather than acking", async () => {
        const { attendee, listing } = await owing(1500);
        const result = await settleFor(
          "cs_stale_status",
          attendee.id,
          listing.id,
          900,
        );
        expect((result as { status: number }).status).toBe(409);
      });

      test("leaves the balance untouched", async () => {
        const { attendee, listing } = await owing(1500);
        await settleFor("cs_stale_keep", attendee.id, listing.id, 900);
        const state = await getAttendeeBalanceState(attendee.id);
        expect(state?.remainingBalance).toBe(1500);
      });
    });
  },
);
