// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectMultiListingStageRemoved,
  expectSessionFailed,
  expectStagedAttendeeRemovedAndRefunded,
  expectWebhookKeptAndRefunded,
  postWebhookAndAssert,
  stubRefundPayment,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > multi-ticket price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket webhook removes and refunds when capacity is exceeded", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Cap 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi WH Cap 2",
        unitPrice: 300,
      });

      // Fill listing2 to capacity
      await bookAttendee(listing2, {
        email: "existing@example.com",
        name: "Existing",
        quantity: 1,
      });

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 800,
          eventId: "evt_multi_cap",
          metadata: signedMeta(
            {
              email: "cap@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 300, q: 1 },
              ]),
              name: "Multi Cap",
            },
            800,
          ),
          paymentIntent: "pi_multi_cap",
          sessionId: "cs_multi_cap",
        }),
      );

      const mockRefund = stubRefundPayment("re_multi_cap");

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
          mockRefund.restore();
        },
        200,
        (json) => {
          expect(json.processed).toBe(false);
          // The capacity reason now lives in the note; the customer sees the
          // generic saved-details message.
          expect(json.error).toContain("couldn't complete your booking");
        },
      );

      // The staged attendee is removed from both listings and refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing1.id,
        "cs_multi_cap",
        mockRefund,
      );
    });

    test("multi-ticket is removed and refunded when prices changed since checkout", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Mismatch 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Mismatch 2",
        unitPrice: 300,
      });

      // expectedTotal = 500*1 + 300*2 = 1100, but amountTotal = 1000
      // Price changed after checkout was created — should refund
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_multi_mismatch",
          metadata: signedMeta(
            {
              email: "multimismatch@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 400, q: 1 },
                { e: listing2.id, p: 600, q: 2 },
              ]),
              name: "Multi Mismatch",
            },
            1000,
          ),
          paymentIntent: "pi_multi_mismatch",
          sessionId: "cs_multi_mismatch",
        }),
        "re_multi_mismatch",
      );

      // The staged attendee is removed from both listings and refunded once.
      await expectMultiListingStageRemoved(listing1.id, listing2.id);
      await expectSessionFailed("cs_multi_mismatch");

      // Verify refund was attempted exactly once
      expect(mockRefund.calls.length).toBe(1);
      expect(mockRefund.calls[0]!.args).toEqual(["pi_multi_mismatch"]);
    });

    test("multi-ticket is removed and refunded when per-item p does not match unit_price * q for non-pay-more listing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // p=500 but listing costs 1000*1=1000, and listing is not can_pay_more
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_item_mismatch",
          metadata: signedMeta(
            {
              email: "mismatch@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Mismatch User",
            },
            500,
          ),
          paymentIntent: "pi_item_mismatch",
          sessionId: "cs_item_mismatch",
        }),
        "re_mismatch",
      );

      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_item_mismatch",
        mockRefund,
      );
    });

    test("multi-ticket is removed and refunded when sum(p) does not equal amountTotal", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // p=2000 is valid for can_pay_more (>= 1000), but amountTotal=1500 != sum(p)=2000
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1500,
          eventId: "evt_total_mismatch",
          metadata: signedMeta(
            {
              email: "total@example.com",
              items: JSON.stringify([{ e: listing.id, p: 2000, q: 1 }]),
              name: "Total Mismatch",
            },
            1500,
          ),
          paymentIntent: "pi_total_mismatch",
          sessionId: "cs_total_mismatch",
        }),
        "re_total",
      );

      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_total_mismatch",
        mockRefund,
      );
    });
  },
);
