import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { SQUARE_ORDER_META, squareMoney } from "#test/lib/square/fixtures.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";

const paymentEvent = (orderId: string, paymentId: string): WebhookEvent => ({
  data: {
    object: {
      payment: {
        id: paymentId,
        order_id: orderId,
        status: "COMPLETED",
      },
    },
  },
  id: `event_${paymentId}`,
  type: "payment.updated",
});

const order = (orderId: string, paymentId?: string) => ({
  id: orderId,
  metadata: SQUARE_ORDER_META,
  ...(paymentId ? { tenders: [{ paymentId }] } : {}),
  totalMoney: squareMoney(1000),
});

const completedPayment = (orderId: string, paymentId: string) => ({
  amountMoney: squareMoney(1000),
  id: paymentId,
  orderId,
  status: "COMPLETED",
});

describe("Square webhook session resolution", () => {
  beforeEach(createTestDb);
  afterEach(resetDb);

  test("uses the exact webhook payment instead of a stale order tender", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve(order("order_stale", "pay_stale")),
        ),
        payment: stub(squareApi, "retrievePayment", (paymentId) =>
          Promise.resolve(completedPayment("order_stale", paymentId)),
        ),
      }),
      async ({ payment }) => {
        const result = await squarePaymentProvider.resolveWebhookSession(
          paymentEvent("order_stale", "pay_webhook"),
        );
        expect(payment.calls.map((call) => call.args)).toEqual([
          ["pay_webhook"],
        ]);
        expect(result).toMatchObject({
          amountTotal: 1000,
          paymentReference: "pay_webhook",
        });
      },
    );
  });

  test("returns retry when the Square order is temporarily absent", async () => {
    await withMocks(
      () => stub(squareApi, "retrieveOrder", () => Promise.resolve(null)),
      async () => {
        expect(
          await squarePaymentProvider.resolveWebhookSession(
            paymentEvent("order_missing", "pay_missing_order"),
          ),
        ).toBe("retry");
      },
    );
  });

  test("returns retry when the exact Square payment is temporarily absent", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve(order("order_missing_payment")),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve(null),
        ),
      }),
      async () => {
        expect(
          await squarePaymentProvider.resolveWebhookSession(
            paymentEvent("order_missing_payment", "pay_missing"),
          ),
        ).toBe("retry");
      },
    );
  });

  for (const [name, paymentId, invalidPayment] of [
    [
      "different payment id",
      "pay_expected",
      { ...completedPayment("order_invalid", "pay_other"), id: "pay_wrong" },
    ],
    [
      "non-completed status",
      "pay_status",
      { ...completedPayment("order_invalid", "pay_status"), status: "PENDING" },
    ],
    [
      "different order",
      "pay_order",
      { ...completedPayment("order_other", "pay_order") },
    ],
    [
      "missing amount",
      "pay_amount",
      {
        id: "pay_amount",
        orderId: "order_invalid",
        status: "COMPLETED",
      },
    ],
    [
      "different currency",
      "pay_currency",
      {
        ...completedPayment("order_invalid", "pay_currency"),
        amountMoney: squareMoney(1000, "GBP"),
      },
    ],
    [
      "invalid refund",
      "pay_refund",
      {
        ...completedPayment("order_invalid", "pay_refund"),
        refundedMoney: squareMoney(1001),
      },
    ],
  ] as const) {
    test(`returns retry for a Square payment with ${name}`, async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve(order("order_invalid", paymentId)),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve(invalidPayment),
          ),
        }),
        async () => {
          expect(
            await squarePaymentProvider.resolveWebhookSession(
              paymentEvent("order_invalid", paymentId),
            ),
          ).toBe("retry");
        },
      );
    });
  }

  /** Stub order + payment for a refunded payment and run assertions. */
  const withRefundedPayment = (
    refundedAmount: number,
    body: () => Promise<void>,
  ) =>
    withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve(order("order_refunded", "pay_refunded")),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve({
            ...completedPayment("order_refunded", "pay_refunded"),
            refundedMoney: squareMoney(refundedAmount),
          }),
        ),
      }),
      body,
    );

  test("processes a partially refunded Square payment as paid", async () => {
    await withRefundedPayment(1, async () => {
      const result = await squarePaymentProvider.resolveWebhookSession(
        paymentEvent("order_refunded", "pay_refunded"),
      );
      expect(result).not.toBe("skip");
      expect(result).toMatchObject({
        paymentReference: "pay_refunded",
        paymentStatus: "paid",
      });
    });
  });

  test("skips a fully refunded Square payment", async () => {
    await withRefundedPayment(1000, async () => {
      expect(
        await squarePaymentProvider.resolveWebhookSession(
          paymentEvent("order_refunded", "pay_refunded"),
        ),
      ).toBe("skip");
    });
  });

  test("replays a terminal Square payment after it is refunded", async () => {
    await reserveSession("order_terminal");
    await markSessionFailed("order_terminal", { error: "Stored failure" });
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve(order("order_terminal", "pay_terminal")),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve({
            ...completedPayment("order_terminal", "pay_terminal"),
            refundedMoney: squareMoney(1000),
          }),
        ),
      }),
      async () => {
        expect(
          await squarePaymentProvider.resolveWebhookSession(
            paymentEvent("order_terminal", "pay_terminal"),
          ),
        ).toMatchObject({ paymentReference: "pay_terminal" });
      },
    );
  });
});
