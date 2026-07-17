/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { refundSpec } from "#routes/api/payment-processing/refunds.ts";
import { refundStagedBooking } from "#routes/api/payment-processing/store-refund.ts";
import {
  beginCheckoutStageRefund,
  finalizeCheckoutStageRefund,
  loadCheckoutStageByPaymentSession,
} from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
import {
  releaseReservation,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  attendeeIds,
  intentFor,
  paidSession,
  stageSession,
} from "./staged-runtime.helpers.ts";

/* jscpd:ignore-end */

describeWithEnv(
  "payment processing > staged refund errors",
  { db: true },
  () => {
    test("refunds and removes a stage whose stored booking identity changed", async () => {
      await setupStripe();
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      await stageSession("stage-mismatch", intent);
      await execute(
        `UPDATE listing_attendees SET package_group_id = 99
        WHERE listing_id = ?`,
        [listing.id],
      );
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({
          id: "stage-mismatch-refund",
          status: "succeeded",
        } as never),
      );
      try {
        const result = await processPaymentSession(
          "stage-mismatch",
          paidSession("stage-mismatch", intent),
        );
        expect(result).toMatchObject({ refunded: true, success: false });
        if (result.success)
          throw new Error("Expected stage mismatch to refund");
        expect(result.error).toBe("We couldn't complete your booking.");
        expect(refund.calls.length).toBe(1);
        expect(await attendeeIds()).toEqual([]);
      } finally {
        refund.restore();
      }
    });

    test("fails before provider IO when a refund stage is missing", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const data = paidSession("missing-refund-stage", intent);
      await expect(
        refundStagedBooking(
          data.session,
          listing.id,
          refundSpec("unexpected_error")("missing stage test"),
        ),
      ).rejects.toThrow("Checkout stage missing-refund-stage is missing");
    });

    test("keeps the stage and attendee when terminal refund claims no payment", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const attendeeId = await stageSession("lost-refund-claim", intent);
      expect((await reserveSession("lost-refund-claim")).reserved).toBe(true);
      await beginCheckoutStageRefund("lost-refund-claim");
      const stage =
        await loadCheckoutStageByPaymentSession("lost-refund-claim");
      if (!stage) throw new Error("Expected refunding stage");
      await releaseReservation("lost-refund-claim");

      await expect(
        finalizeCheckoutStageRefund({
          failure: { error: "Refunded", refunded: true, status: 200 },
          legs: [],
          paymentReference: "payment-lost-refund-claim",
          stage,
        }),
      ).rejects.toThrow(
        "Checkout refund lost-refund-claim was not ready to finalize",
      );
      expect(
        await loadCheckoutStageByPaymentSession("lost-refund-claim"),
      ).toMatchObject({ attendeeId, state: "refunding" });
      expect(await attendeeIds()).toEqual([{ id: attendeeId }]);
    });
  },
);
