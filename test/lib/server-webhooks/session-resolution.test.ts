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
  signedMeta,
  singleItem,
  webhookMeta,
} from "#test-utils";

describeWithEnv("server webhooks > session resolution", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("webhook with checkout listing type but no extractable session acknowledges without processing", async () => {
    await setupStripe();

    // Listing type matches checkoutCompletedEventType but data lacks metadata
    // so extractSessionFromListing returns null (covers lines 498-500)
    // and data object has no id/order_id so sessionId is null (covers lines 597-602)
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
                // No id, no order_id, no proper metadata
                some_field: "value",
              },
            },
            id: "evt_no_extract",
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

  test("webhook returns pending when resolveWebhookSession returns skip", async () => {
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
            id: "evt_skip",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("skip" as const),
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
      mockResolve.restore();
    }
  });

  test("webhook acknowledges when resolveWebhookSession returns null", async () => {
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
            id: "evt_null",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve(null),
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
      mockResolve.restore();
    }
  });

  test("webhook treats invalid payment_status as unpaid", async () => {
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
                id: "cs_bad_status",
                metadata: webhookMeta({
                  email: "badstatus@example.com",
                  items: singleItem(listing.id, 1, 1000),
                  name: "Bad Status",
                }),
                payment_intent: "pi_bad_status",
                payment_status: "completed", // invalid status, should fall back to "unpaid"
              },
            },
            id: "evt_bad_status",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      // "completed" is not a valid payment status, so paymentStatus defaults to "unpaid"
      // This means the session is treated as unpaid and returns a pending acknowledgement
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

  test("webhook extracts amount_total as number from listing data", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2500,
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
                amount_total: 2500,
                id: "cs_amount_total",
                metadata: signedMeta(
                  {
                    email: "amount@example.com",
                    items: singleItem(listing.id, 1, 2500),
                    name: "Amount User",
                  },
                  2500,
                ),
                payment_intent: "pi_amount_total",
                payment_status: "paid",
              },
            },
            id: "evt_amount_total",
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
          expect(json.processed).toBe(true);
        },
      );

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(
        (attendees[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(2500);
    } finally {
      mockVerify.restore();
    }
  });
});
