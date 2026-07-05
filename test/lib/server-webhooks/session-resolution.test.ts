import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectWebhookProcessed,
  postWebhookAndAssert,
  setupStripe,
  signedMeta,
  singleItem,
  stubWebhookVerify,
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
    const mockVerify = await stubWebhookVerify({
      data: {
        object: {
          // No id, no order_id, no proper metadata
          some_field: "value",
        },
      },
      id: "evt_no_extract",
      type: "checkout.session.completed",
    });

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

  test("webhook returns pending when resolveWebhookSession returns skip", async () => {
    await setupStripe();

    const mockVerify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_skip",
      type: "checkout.session.completed",
    });
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("skip" as const),
    );

    await postWebhookAndAssert(
      () => {
        mockVerify.restore();
        mockResolve.restore();
      },
      200,
      (json) => {
        expect(json.received).toBe(true);
        expect(json.status).toBe("pending");
      },
    );
  });

  test("webhook acknowledges when resolveWebhookSession returns null", async () => {
    await setupStripe();

    const mockVerify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_null",
      type: "checkout.session.completed",
    });
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve(null),
    );

    // Returns 200 to prevent provider retries
    await postWebhookAndAssert(
      () => {
        mockVerify.restore();
        mockResolve.restore();
      },
      200,
      (json) => {
        expect(json.received).toBe(true);
      },
    );
  });

  test("webhook treats invalid payment_status as unpaid", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const mockVerify = await stubWebhookVerify(
      checkoutSessionEvent({
        amountTotal: 1000,
        eventId: "evt_bad_status",
        metadata: webhookMeta({
          email: "badstatus@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Bad Status",
        }),
        paymentIntent: "pi_bad_status",
        paymentStatus: "completed",
        sessionId: "cs_bad_status",
      }),
    );

    // "completed" is not a valid payment status, so paymentStatus defaults to "unpaid"
    // This means the session is treated as unpaid and returns a pending acknowledgement
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

  test("webhook extracts amount_total as number from listing data", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2500,
    });

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 2500,
        eventId: "evt_amount_total",
        metadata: signedMeta(
          {
            email: "amount@example.com",
            items: singleItem(listing.id, 1, 2500),
            name: "Amount User",
          },
          2500,
        ),
        paymentIntent: "pi_amount_total",
        sessionId: "cs_amount_total",
      }),
    );

    const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
    const attendees = await getAttendeesRaw(listing.id);
    expect(attendees.length).toBe(1);
    expect(
      (attendees[0] as unknown as Record<string, unknown>).price_paid,
    ).toBe(2500);
  });
});
