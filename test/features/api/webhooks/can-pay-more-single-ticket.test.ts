// jscpd:ignore-start
import { afterEach, it as test } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectAttendeeWithPricePaid,
  expectStagedAttendeeRemovedAndRefunded,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > can_pay_more (single-ticket)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("single-ticket can_pay_more accepts amount above minimum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 2500,
          eventId: "evt_pay_more",
          metadata: signedMeta(
            {
              email: "generous@example.com",
              items: singleItem(listing.id, 1, 2500),
              name: "Generous User",
            },
            2500,
          ),
          paymentIntent: "pi_pay_more",
          sessionId: "cs_pay_more",
        }),
      );

      // Verify attendee was created with the actual amount paid (2500), not the minimum (1000)
      await expectAttendeeWithPricePaid(listing.id, 2500);
    });

    test("single-ticket can_pay_more removes and refunds amount below minimum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_pay_less",
          metadata: signedMeta(
            {
              email: "cheap@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Cheap User",
            },
            500,
          ),
          paymentIntent: "pi_pay_less",
          sessionId: "cs_pay_less",
        }),
        "re_pay_less",
      );

      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_pay_less",
        mockRefund,
      );
    });

    test("single-ticket can_pay_more removes and refunds amount above maximum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 20000,
          eventId: "evt_pay_too_much",
          metadata: signedMeta(
            {
              email: "overpay@example.com",
              items: singleItem(listing.id, 1, 20000),
              name: "Overpay User",
            },
            20000,
          ),
          paymentIntent: "pi_pay_too_much",
          sessionId: "cs_pay_too_much",
        }),
        "re_pay_too_much",
      );

      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_pay_too_much",
        mockRefund,
      );
    });
  },
);
