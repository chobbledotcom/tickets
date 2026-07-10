import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { RefundPaymentInput } from "#shared/square.ts";
import { retrievePayment, squareApi } from "#shared/square.ts";
import { withMocks } from "#test-utils";
import { createMockClient, describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("retrieveOrder", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrieveOrder("order_123");
      expect(result).toBeNull();
    });

    test("returns null when SDK returns no order", async () => {
      const { client, ordersGet } = createMockClient({
        ordersGet: () => Promise.resolve({ order: null }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.retrieveOrder("order_missing");
          expect(result).toBeNull();
          expect(ordersGet.calls[0]!.args[0]).toEqual({
            orderId: "order_missing",
          });
        },
      );
    });

    test("maps tender paymentId correctly", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_tenders",
              metadata: {
                email: "john@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "John",
              },
              state: "COMPLETED",
              tenders: [
                { id: "tender_1", paymentId: "pay_abc" },
                { id: "tender_2", paymentId: null },
              ],
              totalMoney: { amount: BigInt(2000), currency: "USD" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.retrieveOrder("order_tenders");
          expect(result).not.toBeNull();
          expect(result!.tenders).toHaveLength(2);
          expect(result?.tenders?.[0]?.paymentId).toBe("pay_abc");
          expect(result?.tenders?.[1]?.paymentId).toBeUndefined();
        },
      );
    });

    test("returns correct shape with state and id", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_shape",
              metadata: undefined,
              state: "OPEN",
              tenders: undefined,
              totalMoney: { amount: BigInt(0), currency: "USD" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.retrieveOrder("order_shape");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("order_shape");
          expect(result!.state).toBe("OPEN");
          expect(result!.metadata).toBeUndefined();
          expect(result!.tenders).toBeUndefined();
        },
      );
    });

    test("maps totalMoney from order response", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_with_total",
              metadata: {
                email: "john@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "John",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_total" }],
              totalMoney: { amount: BigInt(7500), currency: "GBP" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.retrieveOrder("order_with_total");
          expect(result).not.toBeNull();
          expect(result!.totalMoney.amount).toBe(BigInt(7500));
          expect(result!.totalMoney.currency).toBe("GBP");
        },
      );
    });
  });

  describe("retrievePayment", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrievePayment("pay_123");
      expect(result).toBeNull();
    });

    test("returns null when SDK returns no payment", async () => {
      const { client, paymentsGet } = createMockClient({
        paymentsGet: () => Promise.resolve({ payment: null }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.retrievePayment("pay_missing");
          expect(result).toBeNull();
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_missing",
          });
        },
      );
    });

    test("maps payment fields correctly from SDK response", async () => {
      const { client } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: {
                amount: BigInt(5000),
                currency: "GBP",
              },
              id: "pay_full",
              orderId: "order_999",
              refundedMoney: {
                amount: BigInt(5000),
                currency: "GBP",
              },
              status: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.retrievePayment("pay_full");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_full");
          expect(result!.status).toBe("COMPLETED");
          expect(result!.orderId).toBe("order_999");
          expect(result!.amountMoney!.amount).toBe(BigInt(5000));
          expect(result!.amountMoney!.currency).toBe("GBP");
          expect(result!.refundedMoney!.amount).toBe(BigInt(5000));
          expect(result!.refundedMoney!.currency).toBe("GBP");
        },
      );
    });
  });

  describe("retrievePayment wrapper export", () => {
    test("delegates to squareApi.retrievePayment", async () => {
      const { client, paymentsGet } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(1000), currency: "USD" },
              id: "pay_wrapper",
              orderId: "order_wrapper",
              status: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await retrievePayment("pay_wrapper");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_wrapper");
          expect(result!.status).toBe("COMPLETED");
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_wrapper",
          });
        },
      );
    });
  });

  describe("refundPayment", () => {
    test("returns false when access token not set", async () => {
      const result = await squareApi.refundPayment("pay_123");
      expect(result).toBe(false);
    });

    test("returns false when payment retrieval returns null", async () => {
      await withMocks(
        () => stub(squareApi, "retrievePayment", () => Promise.resolve(null)),
        async () => {
          const result = await squareApi.refundPayment("pay_123");
          expect(result).toBe(false);
        },
      );
    });

    test("calls SDK refund with correct amount from payment", async () => {
      const { client, paymentsGet, refundsRefundPayment } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(4200), currency: "USD" },
              id: "pay_refund_me",
              orderId: "order_refund",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.resolve({
            refund: { id: "refund_123", status: "PENDING" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.refundPayment("pay_refund_me");
          expect(result).toBe(true);

          // Verify payments.get was called to fetch amount
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_refund_me",
          });

          // Verify refund was called with correct amount and payment ID
          const refundArgs = refundsRefundPayment.calls[0]
            ?.args[0] as RefundPaymentInput;
          expect(refundArgs.paymentId).toBe("pay_refund_me");
          expect(refundArgs.amountMoney.amount).toBe(BigInt(4200));
          expect(refundArgs.amountMoney.currency).toBe("USD");
          expect(typeof refundArgs.idempotencyKey).toBe("string");
          expect(refundArgs.idempotencyKey.length).toBeGreaterThan(0);
        },
      );
    });

    test("returns false when refund SDK call throws", async () => {
      const { client } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(1000), currency: "GBP" },
              id: "pay_fail",
              orderId: "order_fail",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.reject(new Error("Square API error")),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
        async () => {
          const result = await squareApi.refundPayment("pay_fail");
          expect(result).toBe(false);
        },
      );
    });
  });
});
