import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  formatPaymentError,
  processPaymentSession,
} from "#routes/api/payment-processing/index.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { bookingIntent, trustedPayment } from "./helpers.ts";

const failure = (refunded?: boolean) => ({
  error: "Booking failed.",
  ...(refunded === undefined ? {} : { refunded }),
  success: false as const,
});

test("formats the action that matches the refund outcome", () => {
  expect(formatPaymentError(failure(true))).toBe(
    "Booking failed. Your payment has been automatically refunded.",
  );
  expect(formatPaymentError(failure(false))).toBe(
    "Booking failed. Please contact support for a refund.",
  );
  expect(formatPaymentError(failure())).toBe("Booking failed.");
});

describeWithEnv(
  "payment processing reservation conflicts",
  { db: true },
  () => {
    test("reports a fresh reservation as still processing", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        unitPrice: 500,
      });
      const id = "cs_direct_in_flight";
      const data = trustedPayment(
        id,
        bookingIntent([{ e: listing.id, p: 500, q: 1 }]),
        500,
      );
      await reserveSession(id);

      expect(await processPaymentSession(id, data)).toEqual({
        error: "Payment is being processed. Please wait a moment and refresh.",
        status: 409,
        success: false,
      });
    });

    test("returns the attendee and stored token for a finalized reservation", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        unitPrice: 500,
      });
      const booked = await bookAttendee(listing, {
        email: "done@example.com",
        name: "Done",
        paymentId: "pi_done",
        quantity: 1,
      });
      if (!booked.success) throw new Error("Failed to create attendee");
      const attendee = booked.attendees[0]!;
      const id = "cs_direct_finalized";
      await finalizeProcessedPayment(id, attendee.id, "stored-token");

      expect(
        await processPaymentSession(
          id,
          trustedPayment(
            id,
            bookingIntent([{ e: listing.id, p: 500, q: 1 }]),
            500,
          ),
        ),
      ).toEqual({
        attendee: { id: attendee.id },
        listingId: listing.id,
        success: true,
        ticketTokens: ["stored-token"],
      });
    });

    test("replays a stored terminal failure without processing again", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        unitPrice: 500,
      });
      const id = "cs_direct_failed";
      await reserveSession(id);
      await markSessionFailed(id, {
        error: "The listing sold out.",
        refunded: true,
        status: 410,
      });

      expect(
        await processPaymentSession(
          id,
          trustedPayment(
            id,
            bookingIntent([{ e: listing.id, p: 500, q: 1 }]),
            500,
          ),
        ),
      ).toEqual({
        error: "The listing sold out.",
        refunded: true,
        status: 410,
        success: false,
      });
    });
  },
);
