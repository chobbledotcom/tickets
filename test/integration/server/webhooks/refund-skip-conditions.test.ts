// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stagePaymentCallback } from "#test-utils/staged-payments.ts";
import {
  checkoutSessionEvent,
  postWebhookAndAssert,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > refund skip conditions",
  { db: true },
  () => {
    test("webhook refund returns false when payment reference is null", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Noref",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_noref",
          metadata: signedMeta(
            {
              email: "noref@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "No Ref",
            },
            500,
          ),
          sessionId: "cs_noref",
        }),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        503,
        (json) => {
          expect(json).toEqual({ status: "retry" });
        },
      );
    });

    test("multi-ticket webhook refunds when a signed listing is missing", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "WH Multi Rollback 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({ unitPrice: 0 });
      const metadata = signedMeta(
        {
          email: "rollback@example.com",
          items: JSON.stringify([
            { e: listing1.id, p: 500, q: 1 },
            { e: listing2.id, p: 0, q: 1 },
          ]),
          name: "Rollback Test",
        },
        500,
      );
      await stagePaymentCallback({
        amountTotal: 500,
        metadata,
        paymentReference: "pi_multi_rollback",
        sessionId: "cs_multi_rollback_cleanup",
      });
      await deleteListing(listing2.id);
      const event = checkoutSessionEvent({
        amountTotal: 500,
        eventId: "evt_multi_rollback",
        metadata,
        paymentIntent: "pi_multi_rollback",
        sessionId: "cs_multi_rollback_cleanup",
      });
      const verify = await stubWebhookVerify(event);
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({
          id: "re_multi_rollback",
          status: "succeeded",
        } as never),
      );
      await postWebhookAndAssert(
        () => {
          verify.restore();
          mockRefund.restore();
        },
        200,
        (json) => expect(json.processed).toBe(false),
      );

      expect(mockRefund.calls.length).toBe(1);
      expect(mockRefund.calls[0]!.args).toEqual(["pi_multi_rollback"]);

      // No attendees created (the session is ignored before any creation pass)
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing1.id);
      expect(attendees.length).toBe(0);
      expect(
        await loadCheckoutStageByPaymentSession("cs_multi_rollback_cleanup"),
      ).toBeNull();
    });
  },
);
