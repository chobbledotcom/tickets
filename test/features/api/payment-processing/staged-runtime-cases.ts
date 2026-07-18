/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { queryAll } from "#shared/db/client.ts";
import type { BookingIntent } from "#shared/payments.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  attendeeIds,
  intentFor,
  paidSession,
  stageSession,
} from "./staged-runtime.helpers.ts";

/* jscpd:ignore-end */

export const registerStagedRuntimeTests = (): void =>
  describeWithEnv("payment processing > staged runtime", { db: true }, () => {
    afterEach(() => resetStripeClient());

    describe("ordinary paid bookings", () => {
      test("releases an incompatible paid session without a stage", async () => {
        const listing = await createTestListing({ unitPrice: 1000 });
        const intent = intentFor(listing.id);

        await expect(
          processPaymentSession(
            "missing-stage",
            paidSession("missing-stage", intent),
          ),
        ).rejects.toThrow(
          "Paid session missing-stage has no compatible checkout stage",
        );
        expect(await attendeeIds()).toEqual([]);
        expect(
          await queryAll(
            "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
            ["missing-stage"],
          ),
        ).toEqual([]);
      });

      test("activates the exact staged attendee instead of creating a fresh one", async () => {
        const listing = await createTestListing({
          maxAttendees: 5,
          unitPrice: 1000,
        });
        const intent = intentFor(listing.id, 2);
        const attendeeId = await stageSession("activate-stage", intent);

        const result = await processPaymentSession(
          "activate-stage",
          paidSession("activate-stage", intent),
        );

        expect(result).toMatchObject({
          attendee: { id: attendeeId },
          success: true,
        });
        expect(await attendeeIds()).toEqual([{ id: attendeeId }]);
        expect(
          await queryAll(
            "SELECT listing_id, quantity FROM listing_attendees WHERE attendee_id = ?",
            [attendeeId],
          ),
        ).toEqual([{ listing_id: listing.id, quantity: 2 }]);
        expect(
          await loadCheckoutStageByPaymentSession("activate-stage"),
        ).toBeNull();
      });

      test("activates every staged row in a multi-listing order", async () => {
        const first = await createTestListing({ unitPrice: 400 });
        const second = await createTestListing({ unitPrice: 600 });
        const intent: BookingIntent = {
          ...intentFor(first.id, 1, 400),
          items: [
            { e: first.id, p: 400, q: 1 },
            { e: second.id, p: 1200, q: 2 },
          ],
        };
        const attendeeId = await stageSession("activate-multi", intent);

        const result = await processPaymentSession(
          "activate-multi",
          paidSession("activate-multi", intent),
        );

        expect(result).toMatchObject({
          attendee: { id: attendeeId },
          success: true,
        });
        expect(
          await queryAll(
            `SELECT listing_id, quantity FROM listing_attendees
            WHERE attendee_id = ? ORDER BY listing_id`,
            [attendeeId],
          ),
        ).toEqual([
          { listing_id: first.id, quantity: 1 },
          { listing_id: second.id, quantity: 2 },
        ]);
      });
    });
  });
