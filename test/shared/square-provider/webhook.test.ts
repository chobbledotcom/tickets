/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/wire.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { rejectionMessage } from "#test-utils/assertions.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { asSession } from "#test-utils/payment-session.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test-utils/square/fixtures.ts";
import {
  completedSquareWebhook,
  squareOrderRead,
  squarePaymentRead,
} from "#test-utils/square/outcomes.ts";

/* jscpd:ignore-end */

describe("square-provider resolveWebhookSession", () => {
  const debug = setupSquareProviderSuite();

  test("extracts order_id from nested Square payment object", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve(
            squareOrderRead({
              id: "order_nested_456",
              metadata: {
                email: "alice@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Alice",
                price_proof: "0.test-signature",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_nested_123" }],
              totalMoney: { amount: BigInt(1000), currency: "GBP" },
            }),
          ),
        ),
        payment: stub(squareApi, "readPayment", () =>
          Promise.resolve(
            squarePaymentRead({
              id: "pay_nested_123",
              status: "COMPLETED",
            }),
          ),
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
        expect(mocks.order.calls.map((call) => call.args)).toEqual([
          ["order_nested_456"],
        ]);
      },
    );
  });

  /** Stubs the order and the payment Square answers the webhook with. */
  const withOrderAndPayment = (
    order: Parameters<typeof squareOrderRead>[0],
    payment: SquarePayment | null,
  ) => ({
    order: stub(squareApi, "readOrder", () =>
      Promise.resolve(squareOrderRead(order)),
    ),
    payment: stub(squareApi, "readPayment", () =>
      Promise.resolve(squarePaymentRead(payment)),
    ),
  });

  test("validates what the payment took, not what the order asked for", async () => {
    // A partial payment against a £10 order would otherwise be handed on as
    // £10 and match the signed price, booking a half-paid order as paid.
    await withMocks(
      () =>
        withOrderAndPayment(
          {
            id: "order_partial",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            totalMoney: squareMoney(1000),
          },
          {
            amountMoney: squareMoney(500),
            id: "pay_partial",
            status: "COMPLETED",
          },
        ),
      async () => {
        const result = await completedSquareWebhook(
          "pay_partial",
          "order_partial",
        );
        expect(asSession(result).amountTotal).toBe(500);
        expect(asSession(result).currency).toBe("GBP");
      },
    );
  });

  test("refuses a completed payment that names no amount", async () => {
    // Standing the order total in for money Square did not report would let an
    // unreadable charge match the signed price and book as paid in full.
    await withMocks(
      () =>
        withOrderAndPayment(
          {
            id: "order_no_amount",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            totalMoney: squareMoney(1000),
          },
          { id: "pay_no_amount", status: "COMPLETED" },
        ),
      async () => {
        const result = await completedSquareWebhook(
          "pay_no_amount",
          "order_no_amount",
        );
        expect(result).toEqual(
          expect.objectContaining({
            paymentReference: "pay_no_amount",
            provider: "square",
            reason: "malformed_charge",
            refundable: true,
            sessionId: "order_no_amount",
          }),
        );
      },
    );
  });

  test("asks to be retried when the completed payment cannot be read back", async () => {
    // Square said COMPLETED, so a failed read-back is a blip on its side. Going
    // quiet here would acknowledge the captured charge as pending and Square
    // would never deliver it again.
    await withMocks(
      () =>
        withOrderAndPayment(
          {
            id: "order_blip",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            totalMoney: squareMoney(1000),
          },
          null,
        ),
      async () => {
        expect(
          await rejectionMessage(
            completedSquareWebhook("pay_blip", "order_blip"),
          ),
        ).toBe(
          "Square payment did not read back as completed (status=unreadable)",
        );
      },
    );
  });

  test("reports a blank payment status as blank, not as unreadable", async () => {
    // "unreadable" is reserved for a payment Square would not give us at all.
    // A payment that came back carrying no status is a different fault, and
    // saying so is what stops someone chasing an outage that never happened.
    await withMocks(
      () =>
        withOrderAndPayment(
          {
            id: "order_blank_status",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            totalMoney: squareMoney(1000),
          },
          { id: "pay_blank_status", status: "" },
        ),
      async () => {
        expect(
          await rejectionMessage(
            completedSquareWebhook("pay_blank_status", "order_blank_status"),
          ),
        ).toBe("Square payment did not read back as completed (status=)");
      },
    );
  });

  test("books a completed payment whose order has no tender yet", async () => {
    // The completed event wins while Square's order tenders lag behind it.
    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve(
            squareOrderRead({
              id: "order_no_tender",
              metadata: SQUARE_ORDER_META,
              state: "COMPLETED",
              totalMoney: squareMoney(1000),
            }),
          ),
        ),
        payment: stub(squareApi, "readPayment", () =>
          Promise.resolve(
            squarePaymentRead({
              amountMoney: squareMoney(1000),
              id: "pay_lagging",
              status: "COMPLETED",
            }),
          ),
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
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve(
            squareOrderRead({
              id: "order_two_payments",
              metadata: SQUARE_ORDER_META,
              state: "COMPLETED",
              tenders: [{ id: "tender_old", paymentId: "pay_earlier" }],
              totalMoney: squareMoney(1000),
            }),
          ),
        ),
        payment: stub(squareApi, "readPayment", () =>
          Promise.resolve(
            squarePaymentRead({
              amountMoney: squareMoney(1000),
              id: "pay_latest",
              status: "COMPLETED",
            }),
          ),
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

  test("refuses a completed payment without its order id", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder"),
        payment: stub(squareApi, "readPayment"),
      }),
      async (mocks) => {
        const message = await rejectionMessage(
          squarePaymentProvider.resolveWebhookSession({
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
          }),
        );
        expect(message).toBe("Completed Square payment is missing order id");
        expect(message).not.toContain("pay_fallback_id");
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

  test("skips a completed payment for an order with no app metadata", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve(
            squareOrderRead({
              id: "order_no_meta",
              metadata: {},
              state: "COMPLETED",
              totalMoney: { amount: BigInt(1000), currency: "GBP" },
            }),
          ),
        ),
        payment: stub(squareApi, "readPayment"),
      }),
      async ({ payment }) => {
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
        expect(payment.calls).toHaveLength(0);
      },
    );
  });

  test("refuses a completed payment whose order is not readable yet", async () => {
    await withMocks(
      () =>
        stub(squareApi, "readOrder", () =>
          Promise.resolve(squareOrderRead(null)),
        ),
      async () => {
        // Square named a COMPLETED payment, so the order exists and has not
        // caught up. Acknowledging would stop the redelivery and leave the
        // buyer charged with no booking.
        expect(
          await rejectionMessage(
            completedSquareWebhook("pay_lagging", "order_lagging"),
          ),
        ).toBe("Square order is not readable yet for a completed payment");
      },
    );
  });

  test("handles flat listing object without payment wrapper", async () => {
    await withMocks(
      () =>
        stub(squareApi, "readOrder", () =>
          Promise.resolve(squareOrderRead(null)),
        ),
      async (mockOrder) => {
        // The order id is read straight off the object rather than a nested
        // payment key. It reaching readOrder is the whole point here; the
        // refusal after that belongs to the missing-order case above.
        await rejectionMessage(
          squarePaymentProvider.resolveWebhookSession({
            data: {
              object: {
                id: "pay_flat",
                order_id: "order_flat",
                status: "COMPLETED",
              },
            },
            id: "evt_flat",
            type: "payment.updated",
          }),
        );
        expect(mockOrder.calls[0]!.args[0]).toBe("order_flat");
      },
    );
  });
});
