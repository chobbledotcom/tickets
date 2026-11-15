import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stripeRefundRequestShape } from "#test-utils/stripe/fixtures.ts";
import { expectTwoListingOrderKeptAndRefunded } from "#test-utils/webhooks/multi-listing-orders.ts";
import {
  expectWebhookKeptAndRefunded,
  stubRefundPayment,
} from "#test-utils/webhooks/stripe.ts";
import {
  checkoutSessionEvent,
  expectKeptAsQuantityZeroAndRefunded,
  postWebhookAndAssert,
} from "#test-utils/webhooks.ts";

describeWithEnv(
  "server webhooks > multi-ticket price-mismatch refunds",
  { db: true },
  () => {
    test("multi-ticket webhook keeps and refunds when capacity exceeded", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
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

      const mockRefund = stubRefundPayment("re_multi_cap", 800);

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
          assert(typeof json.error === "string");
          assertStringIncludes(json.error, "saved your details");
        },
      );

      // Signed by us → the order is kept as a quantity-0 placeholder (one
      // attendee across both listings), not dropped, and refunded once.
      await expectKeptAsQuantityZeroAndRefunded(
        listing1.id,
        "cs_multi_cap",
        mockRefund,
      );
    });

    test("multi-ticket is kept and refunded when prices changed since checkout", async () => {
      await setupStripe();

      // expectedTotal = 500*1 + 300*2 = 1100, but amountTotal = 1000: the
      // prices changed after checkout was created.
      const { attendee, mockRefund } =
        await expectTwoListingOrderKeptAndRefunded(
          "multi_mismatch",
          {
            amountTotal: 1000,
            email: "multimismatch@example.com",
            payer: "Multi Mismatch",
          },
          [
            {
              name: "Multi Mismatch 1",
              price: 400,
              quantity: 1,
              unitPrice: 500,
            },
            {
              name: "Multi Mismatch 2",
              price: 600,
              quantity: 2,
              unitPrice: 300,
            },
          ],
        );

      const { getNoteRows } = await import("#db/notes/queries.ts");
      expect((await getNoteRows("attendee", [attendee.id])).length).toBe(1);

      // Verify refund was attempted exactly once
      expect(mockRefund.calls.length).toBe(1);
      expect(mockRefund.calls[0]!.args).toEqual([
        stripeRefundRequestShape("pi_multi_mismatch", 1000),
      ]);
    });

    // Each case sends an order whose items do not add up to the amount
    // charged: the first names a price below the listing's own, the second a
    // sum above the amount charged.
    const singleListingRefusals = [
      {
        amountTotal: 500,
        canPayMore: false,
        email: "mismatch@example.com",
        id: "item_mismatch",
        name: "multi-ticket keeps and refunds when per-item p does not match unit_price * q for non-pay-more listing",
        payer: "Mismatch User",
        price: 500,
        refundId: "re_mismatch",
      },
      {
        amountTotal: 1500,
        canPayMore: true,
        email: "total@example.com",
        id: "total_mismatch",
        name: "multi-ticket keeps and refunds when sum(p) does not equal amountTotal",
        payer: "Total Mismatch",
        price: 2000,
        refundId: "re_total",
      },
    ];

    for (const refusal of singleListingRefusals) {
      test(refusal.name, async () => {
        await setupStripe();

        // The listing costs 1000*1=1000; only the metadata price differs.
        const listing = await createTestListing({
          canPayMore: refusal.canPayMore,
          maxAttendees: 50,
          unitPrice: 1000,
        });

        const { mockRefund } = await expectWebhookKeptAndRefunded(
          checkoutSessionEvent({
            amountTotal: refusal.amountTotal,
            eventId: `evt_${refusal.id}`,
            metadata: signedMeta(
              {
                email: refusal.email,
                items: JSON.stringify([
                  { e: listing.id, p: refusal.price, q: 1 },
                ]),
                name: refusal.payer,
              },
              refusal.amountTotal,
            ),
            paymentIntent: `pi_${refusal.id}`,
            sessionId: `cs_${refusal.id}`,
          }),
          refusal.refundId,
        );

        // Signed by us → the booking is kept as a quantity-0 placeholder and
        // refunded once, with a system note recording the reason.
        await expectKeptAsQuantityZeroAndRefunded(
          listing.id,
          `cs_${refusal.id}`,
          mockRefund,
        );
      });
    }
  },
);
