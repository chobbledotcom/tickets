// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  configureSquare,
  squareMoney,
} from "#test/test-utils/square/fixtures.ts";
import { squareOrderRead } from "#test/test-utils/square/outcomes.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  mockWebhookRequest,
  withExpectedError,
  withMocks,
} from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv("Square payment webhooks", { db: true }, () => {
  test("keeps a completed payment without an order retryable", async () => {
    await configureSquare();
    await settings.update.paymentProvider("square");
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
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve(squareOrderRead(null)),
        ),
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
          )
        );
        expect(response.status).toBe(503);
        expect(order.calls).toHaveLength(0);
        expect(payment.calls).toHaveLength(0);
      },
    );
  });

  test("keeps a completed payment with malformed order metadata retryable", async () => {
    await configureSquare();
    await settings.update.paymentProvider("square");
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

    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve(
            squareOrderRead({
              id: "order-private-sentinel",
              metadata: {},
              state: "COMPLETED",
              totalMoney: squareMoney(1000),
            }),
          ),
        ),
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
          )
        );
        expect(response.status).toBe(503);
        expect(order.calls).toHaveLength(1);
        expect(payment.calls).toHaveLength(0);
      },
    );
  });
});
