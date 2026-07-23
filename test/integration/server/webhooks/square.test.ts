// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  activateSquare,
  refundedSquareSessionMocks,
  squarePaymentEvent,
} from "#test/lib/square/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest, withMocks } from "#test-utils/mocks.ts";
import { stagePaymentCallback } from "#test-utils/staged-payments.ts";

// jscpd:ignore-end

const squareWebhookRequest = (): Request =>
  mockWebhookRequest(
    {},
    { "x-square-hmacsha256-signature": "square-signature" },
  );

const verifyEvent = (event: WebhookEvent) =>
  stub(squarePaymentProvider, "verifyWebhookSignature", () =>
    Promise.resolve({ listing: event, valid: true as const }),
  );

const withRefundedEvent = (
  eventId: string,
  orderId: string,
  paymentId: string,
  metadata: Record<string, string>,
  body: (response: Response) => void | Promise<void>,
): Promise<void> => {
  const event = squarePaymentEvent(eventId, orderId, paymentId);
  return withMocks(
    () => ({
      ...refundedSquareSessionMocks(orderId, paymentId, metadata, false),
      verify: verifyEvent(event),
    }),
    async () => await body(await handleRequest(squareWebhookRequest())),
  );
};

describeWithEnv("Square payment webhooks", { db: true }, () => {
  test("acknowledges an unrelated payment without order API work", async () => {
    await activateSquare();
    const event: WebhookEvent = {
      data: {
        object: {
          payment: { id: "unrelated-payment", status: "COMPLETED" },
        },
      },
      id: "unrelated-payment-event",
      type: "payment.updated",
    };

    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder"),
        payment: stub(squareApi, "retrievePayment"),
        verify: verifyEvent(event),
      }),
      async ({ order, payment }) => {
        const response = await handleRequest(squareWebhookRequest());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true });
        expect(order.calls).toHaveLength(0);
        expect(payment.calls).toHaveLength(0);
      },
    );
  });

  test("replays a terminal refund instead of asking Square to retry", async () => {
    await activateSquare();
    const listing = await createTestListing({ unitPrice: 1000 });
    const orderId = "square-webhook-terminal";
    const paymentId = "square-webhook-payment";
    const metadata = signedMeta(
      {
        email: "square-webhook@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Square webhook",
      },
      1000,
    );
    await reserveSession(orderId);
    await markSessionFailed(orderId, {
      error: "Stored Square webhook failure.",
      refunded: true,
      status: 200,
    });
    await withRefundedEvent(
      "square-terminal-event",
      orderId,
      paymentId,
      metadata,
      async (response) => {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          error: "Stored Square webhook failure.",
          processed: false,
          received: true,
        });
      },
    );
  });

  test("acknowledges a fresh external refund without activating its stage", async () => {
    await activateSquare();
    const listing = await createTestListing({ unitPrice: 1000 });
    const orderId = "square-webhook-fresh-refund";
    const paymentId = "square-webhook-fresh-payment";
    const metadata = signedMeta(
      {
        email: "square-webhook-fresh@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Square webhook fresh",
      },
      1000,
    );
    await stagePaymentCallback({
      amountTotal: 1000,
      metadata,
      paymentReference: paymentId,
      provider: "square",
      sessionId: orderId,
    });
    await withRefundedEvent(
      "square-fresh-refund-event",
      orderId,
      paymentId,
      metadata,
      async (response) => {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          received: true,
          status: "pending",
        });
      },
    );
    expect(await loadCheckoutStageByPaymentSession(orderId)).toMatchObject({
      state: "pending",
    });
  });
});
