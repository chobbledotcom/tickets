import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findCompletedSquarePayment,
  type SquareOrder,
  type SquarePayment,
  squareCloseTenderPaymentId,
  squareTenderPaymentIds,
} from "#shared/square-payments.ts";

const order = (overrides: Partial<SquareOrder> = {}): SquareOrder => ({
  id: "order_1",
  tenders: [{ paymentId: "payment_1" }],
  totalMoney: { amount: BigInt(100), currency: "USD" },
  ...overrides,
});

const payment = (overrides: Partial<SquarePayment> = {}): SquarePayment => ({
  amountMoney: { amount: BigInt(100), currency: "USD" },
  id: "payment_1",
  orderId: "order_1",
  status: "COMPLETED",
  ...overrides,
});

const completed = (value: SquarePayment | null, input = order()) =>
  findCompletedSquarePayment(() => Promise.resolve(value))(input);

describe("Square completed payments", () => {
  test("checks only the ten newest tenders in newest-first order", () => {
    const tenders = Array.from({ length: 12 }, (_, index) => ({
      paymentId: `payment_${index}`,
    }));
    expect(squareTenderPaymentIds(order({ tenders }))).toEqual([
      "payment_11",
      "payment_10",
      "payment_9",
      "payment_8",
      "payment_7",
      "payment_6",
      "payment_5",
      "payment_4",
      "payment_3",
      "payment_2",
    ]);
  });

  test("returns no tender ids when an order has no tenders", () => {
    expect(squareTenderPaymentIds(order({ tenders: undefined }))).toEqual([]);
  });

  test("close inspection accepts one tender payment id", () => {
    expect(squareCloseTenderPaymentId(order())).toBe("payment_1");
  });

  test("close inspection rejects several tender payment ids", () => {
    expect(() =>
      squareCloseTenderPaymentId(
        order({
          tenders: [{ paymentId: "payment_1" }, { paymentId: "payment_2" }],
        }),
      ),
    ).toThrow("multiple tenders");
  });

  test("accepts a zero-value completed payment", async () => {
    await expect(
      completed(
        payment({ amountMoney: { amount: BigInt(0), currency: "USD" } }),
      ),
    ).resolves.toEqual({
      amountTotal: 0,
      paymentReference: "payment_1",
      refundedAmount: 0,
    });
  });

  for (const refundedAmount of [1, 100]) {
    test(`reports a completed payment refunded by ${refundedAmount}`, async () => {
      await expect(
        completed(
          payment({
            refundedMoney: {
              amount: BigInt(refundedAmount),
              currency: "USD",
            },
          }),
        ),
      ).resolves.toEqual({
        amountTotal: 100,
        paymentReference: "payment_1",
        refundedAmount,
      });
    });
  }

  for (const [name, invalid] of [
    ["different payment id", payment({ id: "payment_2" })],
    ["non-completed status", payment({ status: "PENDING" })],
    ["different order", payment({ orderId: "order_2" })],
    ["missing amount", payment({ amountMoney: { currency: "USD" } })],
    ["missing currency", payment({ amountMoney: { amount: BigInt(100) } })],
    [
      "different currency",
      payment({ amountMoney: { amount: BigInt(100), currency: "GBP" } }),
    ],
    [
      "negative amount",
      payment({ amountMoney: { amount: BigInt(-1), currency: "USD" } }),
    ],
    [
      "unsafe amount",
      payment({
        amountMoney: {
          amount: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
          currency: "USD",
        },
      }),
    ],
    [
      "missing refunded amount",
      payment({ refundedMoney: { currency: "USD" } }),
    ],
    [
      "negative refund",
      payment({ refundedMoney: { amount: BigInt(-1), currency: "USD" } }),
    ],
    [
      "refund above the charge",
      payment({ refundedMoney: { amount: BigInt(101), currency: "USD" } }),
    ],
    [
      "refund in another currency",
      payment({ refundedMoney: { amount: BigInt(0), currency: "GBP" } }),
    ],
  ] as const) {
    test(`rejects a completed payment with ${name}`, async () => {
      await expect(completed(invalid)).resolves.toBeNull();
    });
  }
});
