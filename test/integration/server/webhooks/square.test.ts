// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import type { WebhookEvent } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import {
  mockWebhookRequest,
  withExpectedError,
  withMocks,
} from "#test-utils/mocks.ts";
import { chargeMoney, completedRefund } from "#test-utils/payment-state.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { configureSquare, squareMoney } from "#test-utils/square/fixtures.ts";
import {
  squareOrderRead,
  squarePaymentRead,
} from "#test-utils/square/outcomes.ts";

// jscpd:ignore-end

const expectWebhookResponse = async (
  event: WebhookEvent,
  orderRead: ReturnType<typeof squareOrderRead>,
  expectedOrderReads: number,
  expectedStatus: number,
): Promise<void> => {
  await configureSquare();
  await settings.update.paymentProvider("square");
  await withMocks(
    () => ({
      order: stub(squareApi, "readOrder", () => Promise.resolve(orderRead)),
      payment: stub(squareApi, "readPayment"),
      verify: stub(squarePaymentProvider, "verifyWebhookSignature", () =>
        Promise.resolve({ listing: event, valid: true as const }),
      ),
    }),
    async ({ order, payment }) => {
      const response = await withExpectedError(() =>
        handleRequest(
          mockWebhookRequest(
            {},
            { "x-square-hmacsha256-signature": "square-signature" },
          ),
        ),
      );
      expect(response.status).toBe(expectedStatus);
      expect(order.calls).toHaveLength(expectedOrderReads);
      expect(payment.calls).toHaveLength(0);
    },
  );
};

describeWithEnv("Square payment webhooks", { db: true }, () => {
  test("keeps a completed payment without an order retryable", async () => {
    const event: WebhookEvent = {
      data: {
        object: {
          payment: { id: "unrelated-payment", status: "COMPLETED" },
        },
      },
      id: "unrelated-payment-event",
      type: "payment.updated",
    };

    await expectWebhookResponse(event, squareOrderRead(null), 0, 503);
  });

  test("keeps a completed payment whose order is not readable yet retryable", async () => {
    // Square named a payment it completed, so the order is ours and has not
    // caught up. A 200 here would end the redelivery and leave the buyer
    // charged with no booking.
    const event: WebhookEvent = {
      data: {
        object: {
          payment: {
            id: "lagging-payment",
            order_id: "lagging-order",
            status: "COMPLETED",
          },
        },
      },
      id: "lagging-payment-event",
      type: "payment.updated",
    };

    await expectWebhookResponse(event, squareOrderRead(null), 1, 503);
  });

  test("acknowledges a completed payment for a foreign Square order", async () => {
    const event: WebhookEvent = {
      data: {
        object: {
          payment: {
            id: "point-of-sale-payment",
            order_id: "point-of-sale-order",
            status: "COMPLETED",
          },
        },
      },
      id: "point-of-sale-event",
      type: "payment.updated",
    };

    await expectWebhookResponse(
      event,
      squareOrderRead({
        id: "point-of-sale-order",
        metadata: { source: "POINT_OF_SALE" },
        state: "COMPLETED",
        totalMoney: squareMoney(1000),
      }),
      1,
      200,
    );
  });

  test("keeps a completed payment with malformed order metadata retryable", async () => {
    const event: WebhookEvent = {
      data: {
        object: {
          payment: {
            id: "payment-private-sentinel",
            order_id: "order-private-sentinel",
            status: "COMPLETED",
          },
        },
      },
      id: "malformed-order-event",
      type: "payment.updated",
    };

    await expectWebhookResponse(
      event,
      squareOrderRead({
        id: "order-private-sentinel",
        metadata: { _origin: "localhost" },
        state: "COMPLETED",
        totalMoney: squareMoney(1000),
      }),
      1,
      503,
    );
  });

  for (const [description, priceProof] of [
    ["no price proof", undefined],
    ["a malformed price proof", "not-a-price-proof"],
  ] as const) {
    test(`keeps a ticket-shaped order with ${description} retryable`, async () => {
      const event: WebhookEvent = {
        data: {
          object: {
            payment: {
              id: "payment-damaged-proof",
              order_id: "order-damaged-proof",
              status: "COMPLETED",
            },
          },
        },
        id: "damaged-proof-event",
        type: "payment.updated",
      };

      await expectWebhookResponse(
        event,
        squareOrderRead({
          id: "order-damaged-proof",
          metadata: {
            _origin: "localhost",
            items: '[{"e":1,"q":1,"p":1000}]',
            name: "Alice",
            ...(priceProof === undefined ? {} : { price_proof: priceProof }),
          },
          state: "COMPLETED",
          totalMoney: squareMoney(1000),
        }),
        1,
        503,
      );
    });
  }

  test("books one attendee across a redelivered completed payment", async () => {
    await configureSquare();
    await settings.update.paymentProvider("square");

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // The order must be readable and the payment must read back COMPLETED:
    // readOrderPayment throws for a completed webhook until both agree, so a
    // readable order alone would keep every delivery retryable.
    const order = squareOrderRead({
      id: "order-square-replay",
      metadata: signedMeta(
        {
          email: "square-replay@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Square Replay",
        },
        1000,
      ),
      state: "COMPLETED",
      tenders: [{ id: "tender-replay", paymentId: "pay-square-replay" }],
      totalMoney: squareMoney(1000),
    });
    const payment = squarePaymentRead({
      amountMoney: squareMoney(1000),
      id: "pay-square-replay",
      status: "COMPLETED",
    });
    const event: WebhookEvent = {
      data: {
        object: {
          payment: {
            id: "pay-square-replay",
            order_id: "order-square-replay",
            status: "COMPLETED",
          },
        },
      },
      id: "square-replay-event",
      type: "payment.updated",
    };

    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder", () => Promise.resolve(order)),
        payment: stub(squareApi, "readPayment", () => Promise.resolve(payment)),
        refund: stub(squareApi, "refundCharge", () =>
          Promise.resolve(completedRefund(chargeMoney())),
        ),
        verify: stub(squarePaymentProvider, "verifyWebhookSignature", () =>
          Promise.resolve({ listing: event, valid: true as const }),
        ),
      }),
      async ({ refund }) => {
        const deliver = () =>
          handleRequest(
            mockWebhookRequest(
              {},
              { "x-square-hmacsha256-signature": "square-signature" },
            ),
          );

        const first = await deliver();
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({ processed: true });

        // The same completed webhook delivered again must book nobody twice.
        const second = await deliver();
        expect(second.status).toBe(200);
        expect(await second.json()).toMatchObject({ processed: true });

        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees).toHaveLength(1);
        expect(attendees[0]?.quantity).toBe(1);

        // The replay identity of Square is the order id: it becomes the
        // processed_payments.payment_session_id, so both deliveries reserve
        // the same row.
        const row = await getProcessedPayment("order-square-replay");
        expect(row?.payment_session_id).toBe("order-square-replay");
        expect(row?.attendee_id).toBe(attendees[0]!.id);

        // A replayed completed booking asks for no refund at all.
        expect(refund.calls).toHaveLength(0);
      },
    );
  });
});
