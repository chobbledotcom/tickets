import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test/test-utils/square/fixtures.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { asSession } from "#test-utils/payment-session.ts";

describe("square-provider resolveWebhookSession", () => {
  const debug = setupSquareProviderSuite();

  test("extracts order_id from nested Square payment object", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve({
            id: "order_nested_456",
            metadata: {
              email: "alice@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Alice",
            },
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_nested_123" }],
            totalMoney: { amount: BigInt(1000), currency: "GBP" },
          }),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve({
            id: "pay_nested_123",
            status: "COMPLETED",
          }),
        ),
      }),
      async (mocks) => {
        const result = await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              payment: {
                id: "pay_nested_123",
                order_id: "order_nested_456",
                status: "COMPLETED",
              },
            },
          },
          id: "evt_square",
          type: "payment.updated",
        });
        expect(result).not.toBe("skip");
        expect(result).not.toBeNull();
        expect(mocks.order.calls[0]!.args[0]).toBe("order_nested_456");
      },
    );
  });

  test("books a completed payment whose order has no tender yet", async () => {
    // Square's tenders can lag the payment webhook. Reading the order alone
    // would call this unpaid, and a captured charge would be acknowledged as
    // pending — so the webhook's own completed payment id is used.
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve({
            id: "order_no_tender",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            totalMoney: squareMoney(1000),
          }),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve({ id: "pay_lagging", status: "COMPLETED" }),
        ),
      }),
      async (mocks) => {
        const result = await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              payment: {
                id: "pay_lagging",
                order_id: "order_no_tender",
                status: "COMPLETED",
              },
            },
          },
          id: "evt_no_tender",
          type: "payment.updated",
        });
        expect(asSession(result).paymentStatus).toBe("paid");
        expect(asSession(result).paymentReference).toBe("pay_lagging");
        expect(mocks.payment.calls).toHaveLength(1);
        expect(mocks.payment.calls[0]!.args).toEqual(["pay_lagging"]);
      },
    );
  });

  test("prefers the webhook's payment over an earlier tender", async () => {
    // The order already carries a tender for a previous payment. The webhook
    // names the one Square just completed, so that is the charge this
    // session records — and the one a refund would have to reach.
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve({
            id: "order_two_payments",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            tenders: [{ id: "tender_old", paymentId: "pay_earlier" }],
            totalMoney: squareMoney(1000),
          }),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve({ id: "pay_latest", status: "COMPLETED" }),
        ),
      }),
      async (mocks) => {
        const result = await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              payment: {
                id: "pay_latest",
                order_id: "order_two_payments",
                status: "COMPLETED",
              },
            },
          },
          id: "evt_two_payments",
          type: "payment.updated",
        });
        expect(asSession(result).paymentReference).toBe("pay_latest");
        expect(mocks.payment.calls).toHaveLength(1);
        expect(mocks.payment.calls[0]!.args).toEqual(["pay_latest"]);
      },
    );
  });

  test("returns skip for non-COMPLETED payment status", async () => {
    const result = await squarePaymentProvider.resolveWebhookSession({
      data: {
        object: {
          payment: {
            id: "pay_pending",
            order_id: "order_pending",
            status: "APPROVED",
          },
        },
      },
      id: "evt_pending",
      type: "payment.updated",
    });
    expect(result).toBe("skip");
    expect(debug().calls.at(-1)?.args).toEqual([
      "[Square] Skipping webhook for non-completed payment (status=APPROVED)",
    ]);
  });

  test("rejects a payment event without a payment id", async () => {
    await expect(
      squarePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            payment: {
              order_id: "order_without_payment",
              status: "COMPLETED",
            },
          },
        },
        id: "evt_no_payment",
        type: "payment.updated",
      }),
    ).rejects.toThrow("Square payment webhook is missing id");
  });

  test("ignores a payment id without its order id", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder"),
        payment: stub(squareApi, "retrievePayment"),
      }),
      async (mocks) => {
        const result = await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              payment: {
                id: "pay_fallback_id",
                status: "COMPLETED",
              },
            },
          },
          id: "evt_no_order",
          type: "payment.updated",
        });
        expect(result).toBeNull();
        expect(mocks.order.calls).toHaveLength(0);
        expect(mocks.payment.calls).toHaveLength(0);
      },
    );
  });

  test("ignores an unrelated event without payment identifiers", async () => {
    expect(
      await squarePaymentProvider.resolveWebhookSession({
        data: {
          object: {},
        },
        id: "evt_refund",
        type: "refund.updated",
      }),
    ).toBeNull();
  });

  test("returns skip when order exists but has no metadata", async () => {
    await withMocks(
      () =>
        stub(squareApi, "retrieveOrder", () =>
          Promise.resolve({
            id: "order_no_meta",
            metadata: {},
            state: "COMPLETED",
            totalMoney: { amount: BigInt(1000), currency: "GBP" },
          }),
        ),
      async () => {
        const result = await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              payment: {
                id: "pay_no_meta",
                order_id: "order_no_meta",
                status: "COMPLETED",
              },
            },
          },
          id: "evt_no_meta",
          type: "payment.updated",
        });
        expect(result).toBe("skip");
      },
    );
  });

  test("handles flat listing object without payment wrapper", async () => {
    await withMocks(
      () => stub(squareApi, "retrieveOrder", () => Promise.resolve(null)),
      async (mockOrder) => {
        const result = await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              id: "pay_flat",
              order_id: "order_flat",
              status: "COMPLETED",
            },
          },
          id: "evt_flat",
          type: "payment.updated",
        });
        expect(mockOrder.calls[0]!.args[0]).toBe("order_flat");
        expect(result).toBe("skip");
      },
    );
  });
});
