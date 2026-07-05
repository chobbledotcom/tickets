import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  bookAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  mockRequest,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  signMeta,
  singleItem,
  stubWebhookVerify,
  webhookMeta,
} from "#test-utils";

describeWithEnv("server webhooks > concurrent processing", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("webhook returns 409 when session is being processed concurrently", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    // Pre-reserve the session to simulate concurrent processing
    const { reserveSession: reserveSessionFn } = await import(
      "#shared/db/processed-payments.ts"
    );
    await reserveSessionFn("cs_webhook_concurrent");

    const mockVerify = await stubWebhookVerify({
      data: {
        object: {
          amount_total: 1000,
          id: "cs_webhook_concurrent",
          metadata: signedMeta(
            {
              email: "concurrent@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Concurrent Webhook",
            },
            1000,
          ),
          payment_intent: "pi_webhook_concurrent",
          payment_status: "paid",
        },
      },
      id: "evt_concurrent",
      type: "checkout.session.completed",
    });

    try {
      const response = await handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(409);
    } finally {
      mockVerify.restore();
    }
  });

  test("multi-ticket being processed returns 409", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Multi Concurrent",
      unitPrice: 500,
    });

    // Pre-reserve the session to simulate concurrent processing
    const { reserveSession: reserveSessionFn } = await import(
      "#shared/db/processed-payments.ts"
    );
    await reserveSessionFn("cs_multi_concurrent");

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 500,
        id: "cs_multi_concurrent",
        metadata: signMeta(
          webhookMeta({
            email: "concurrent@example.com",
            items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
            name: "Concurrent",
          }),
          500,
        ),
        payment_intent: "pi_multi_concurrent",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_multi_concurrent"),
      );
      await expectHtmlResponse(response, 409, "being processed");
    } finally {
      mockRetrieve.restore();
    }
  });

  test("single-ticket being processed returns 409", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    // Pre-reserve the session to simulate concurrent processing
    const { reserveSession: reserveSessionFn } = await import(
      "#shared/db/processed-payments.ts"
    );
    await reserveSessionFn("cs_single_concurrent");

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_single_concurrent",
        metadata: signMeta(
          webhookMeta({
            email: "concurrent@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Concurrent",
          }),
          1000,
        ),
        payment_intent: "pi_single_concurrent",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_single_concurrent"),
      );
      await expectHtmlResponse(response, 409, "being processed");
    } finally {
      mockRetrieve.restore();
    }
  });

  test("returns success for already-processed multi-ticket session", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Multi Already Done",
      unitPrice: 500,
    });
    // Create attendee directly (not via public form which redirects to Stripe for paid listings)
    const result = await bookAttendee(listing, {
      email: "already@example.com",
      name: "Already Done",
      paymentId: "pi_already_done",
      quantity: 1,
    });
    if (!result.success) throw new Error("Failed to create test attendee");
    const attendee = result.attendees[0]!;

    const {
      reserveSession: reserveSessionFn,
      finalizeSession: finalizeSessionFn,
    } = await import("#shared/db/processed-payments.ts");
    await reserveSessionFn("cs_multi_already_done");
    await finalizeSessionFn("cs_multi_already_done", attendee.id, [
      attendee.ticket_token,
    ]);

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
                amount_total: 500,
                id: "cs_multi_already_done",
                metadata: signedMeta(
                  {
                    email: "already@example.com",
                    items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
                    name: "Already Done",
                  },
                  500,
                ),
                payment_intent: "pi_already_done",
                payment_status: "paid",
              },
            },
            id: "evt_already_done",
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
    } finally {
      mockVerify.restore();
    }
  });
});
