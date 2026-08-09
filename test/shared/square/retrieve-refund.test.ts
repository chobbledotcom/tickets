import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squareApi } from "#shared/square.ts";
import { withSquareClient } from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";

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
                totalMoney: { amount: BigInt(2000), currency: "GBP" },
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
                totalMoney: { amount: BigInt(0), currency: "GBP" },
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
                totalMoney: { amount: BigInt(0), currency: "GBP" },
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

    // Square's own values are carried through untouched, however empty they
    // look: a zero total is a real free order, and a blank currency is
    // something the payment boundary must see to refuse. Only a wholly absent
    // money object becomes null.
    for (const [name, given, expected] of [
      [
        "a zero amount",
        { amount: BigInt(0), currency: "GBP" },
        {
          amount: BigInt(0),
          currency: "GBP",
        },
      ],
      [
        "a blank currency",
        { amount: BigInt(500), currency: "" },
        {
          amount: BigInt(500),
          currency: "",
        },
      ],
    ] as const) {
      test(`keeps ${name} on the order total`, async () => {
        await withSquareClient(
          {
            ordersGet: () =>
              Promise.resolve({
                order: {
                  id: "order_edge_total",
                  metadata: { name: "John" },
                  state: "COMPLETED",
                  totalMoney: given,
                },
              }),
          },
          async () => {
            const result = await squareApi.retrieveOrder("order_edge_total");
            expect(result).not.toBeNull();
            if (result === null) return;
            expect(result.totalMoney).toEqual(expected);
          },
        );
      });
    }

    test("carries a missing order total through as null", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_no_total",
                metadata: {
                  email: "john@example.com",
                  items: '[{"e":1,"q":1,"p":0}]',
                  name: "John",
                },
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_no_total" }],
              },
            }),
        },
        async () => {
          // Reaching into a missing money object would throw, and the client
          // wrapper turns a throw into "no order" — so a paid Square charge
          // would be acknowledged unread. Nulls let the payment boundary
          // refuse it and the callback refund it.
          const result = await squareApi.retrieveOrder("order_no_total");
          expect(result).not.toBeNull();
          if (result === null) return;
          expect(result.totalMoney).toEqual({ amount: null, currency: null });
        },
      );
    });

    test("removes null metadata values from an order", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_metadata",
                metadata: {
                  items: '[{"e":1,"q":1,"p":1000}]',
                  name: "Jane",
                  removed: null,
                },
                state: "COMPLETED",
                totalMoney: { amount: BigInt(1000), currency: "GBP" },
              },
            }),
        },
        async () => {
          const result = await squareApi.retrieveOrder("order_metadata");
          expect(result?.metadata).toEqual({
            items: '[{"e":1,"q":1,"p":1000}]',
            name: "Jane",
          });
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
});
