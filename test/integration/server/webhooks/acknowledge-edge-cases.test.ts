// jscpd:ignore-start
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookIgnored,
  expectWebhookPending,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > acknowledging edge-case sessions",
  { db: true },
  () => {
    test("acknowledges non-checkout listings", async () => {
      await setupStripe();

      await expectWebhookIgnored({
        data: { object: {} },
        id: "evt_test",
        type: "payment_intent.created",
      });
    });

    test("acknowledges webhook with unrecognized session metadata", async () => {
      await setupStripe();
      using _retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(null),
      );

      // Returns 200 to prevent provider retries
      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 0,
          eventId: "evt_test",
          metadata: {}, // Missing required fields — not our session
          paymentIntent: "pi_test",
          sessionId: "cs_test",
        }),
      );
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookPending(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_test",
          metadata: webhookMeta({
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
          }),
          paymentIntent: "pi_test",
          paymentStatus: "unpaid",
          sessionId: "cs_test",
        }),
      );
    });

    test("webhook handles non-checkout listing type by acknowledging", async () => {
      await setupStripe();

      await expectWebhookIgnored({
        data: {
          object: {
            id: "pi_test",
          },
        },
        id: "evt_other_type",
        type: "payment_intent.succeeded",
      });
    });
  },
);
