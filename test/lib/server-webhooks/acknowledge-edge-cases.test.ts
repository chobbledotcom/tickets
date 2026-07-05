// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectWebhookIgnored,
  postWebhookAndAssert,
  setupStripe,
  singleItem,
  stubWebhookVerify,
  webhookMeta,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > acknowledging edge-case sessions",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("acknowledges non-checkout listings", async () => {
      await setupStripe();

      const mockVerify = await stubWebhookVerify({
        data: { object: {} },
        id: "evt_test",
        type: "payment_intent.created",
      });

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.received).toBe(true);
        },
      );
    });

    test("acknowledges webhook with unrecognized session metadata", async () => {
      await setupStripe();

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 0,
          eventId: "evt_test",
          metadata: {}, // Missing required fields — not our session
          sessionId: "cs_test",
        }),
      );

      // Returns 200 to prevent provider retries
      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.received).toBe(true);
        },
      );
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockVerify = await stubWebhookVerify(
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

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.status).toBe("pending");
        },
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
