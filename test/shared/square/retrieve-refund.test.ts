import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { retrievePayment, squareApi } from "#shared/square.ts";
import { withSquareClient } from "#test/lib/square/fixtures.ts";
import { describeSquare } from "#test/lib/square/harness.ts";

describeSquare(() => {
  describe("retrieveOrder", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrieveOrder("order_123");
      expect(result).toBeNull();
    });

    test("returns null when SDK returns no order", async () => {
      await withSquareClient(
        { ordersGet: () => Promise.resolve({ order: null }) },
        async ({ ordersGet }) => {
          const result = await squareApi.retrieveOrder("order_missing");
          expect(result).toBeNull();
          expect(ordersGet.calls[0]!.args[0]).toEqual({
            orderId: "order_missing",
          });
        },
      );
    });

    test("maps tender paymentId correctly", async () => {
      await withSquareClient(
        {
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
        },
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
      await withSquareClient(
        {
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
        },
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

    test("drops null order metadata values", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_metadata",
                metadata: {
                  removed_null: null,
                  stored_key: "stored value",
                },
                totalMoney: { amount: BigInt(0), currency: "USD" },
              },
            }),
        },
        async () => {
          const result = await squareApi.retrieveOrder("order_metadata");
          expect(result?.metadata).toEqual({ stored_key: "stored value" });
        },
      );
    });

    test("maps totalMoney from order response", async () => {
      await withSquareClient(
        {
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
        },
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
      await withSquareClient(
        { paymentsGet: () => Promise.resolve({ payment: null }) },
        async ({ paymentsGet }) => {
          const result = await squareApi.retrievePayment("pay_missing");
          expect(result).toBeNull();
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_missing",
          });
        },
      );
    });

    test("maps payment fields correctly from SDK response", async () => {
      await withSquareClient(
        {
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
        },
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
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(1000), currency: "USD" },
                id: "pay_wrapper",
                orderId: "order_wrapper",
                status: "COMPLETED",
              },
            }),
        },
        async ({ paymentsGet }) => {
          const result = await retrievePayment("pay_wrapper");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("pay_wrapper");
          expect(result!.refundedMoney).toBeUndefined();
          expect(result!.status).toBe("COMPLETED");
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_wrapper",
          });
        },
      );
    });
  });
});
