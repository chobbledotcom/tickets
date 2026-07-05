import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  singleItem,
  webhookMeta,
} from "#test-utils";

describeWithEnv(
  "server webhooks > acknowledging edge-case sessions",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("acknowledges non-checkout listings", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: { object: {} },
              id: "evt_test",
              type: "payment_intent.created",
            },
            valid: true,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("acknowledges webhook with unrecognized session metadata", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 0,
                  id: "cs_test",
                  metadata: {}, // Missing required fields — not our session
                  payment_status: "paid",
                },
              },
              id: "evt_test",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1000,
                  id: "cs_test",
                  metadata: webhookMeta({
                    email: "john@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "John",
                  }),
                  payment_intent: "pi_test",
                  payment_status: "unpaid",
                },
              },
              id: "evt_test",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.status).toBe("pending");
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook handles non-checkout listing type by acknowledging", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  id: "pi_test",
                },
              },
              id: "evt_other_type",
              type: "payment_intent.succeeded",
            },
            valid: true,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
      }
    });
  },
);
