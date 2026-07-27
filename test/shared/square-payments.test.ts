import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findCompletedSquarePayments,
  type SquareOrder,
  type SquarePayment,
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
  findCompletedSquarePayments(() => Promise.resolve(value))(input);

describe("Square completed payments", () => {
  test("keeps every tender payment id in newest-first order", () => {
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
      "payment_1",
      "payment_0",
    ]);
  });

  test("returns no tender ids when an order has no tenders", () => {
    expect(squareTenderPaymentIds(order({ tenders: undefined }))).toEqual([]);
  });

  test("does not reorder the order tenders", () => {
    const tenders = [{ paymentId: "payment_a" }, { paymentId: "payment_b" }];
    squareTenderPaymentIds(order({ tenders }));
    expect(tenders).toEqual([
      { paymentId: "payment_a" },
      { paymentId: "payment_b" },
    ]);
  });

  test("skips tenders without a paymentId", () => {
    const tenders = [
      { paymentId: "payment_a" },
      { paymentId: "" },
      { paymentId: "payment_c" },
    ];
    expect(squareTenderPaymentIds(order({ tenders }))).toEqual([
      "payment_c",
      "payment_a",
    ]);
  });

  test("rejects a zero-value completed payment", async () => {
    await expect(
      completed(
        payment({ amountMoney: { amount: BigInt(0), currency: "USD" } }),
        order({ totalMoney: { amount: BigInt(0), currency: "USD" } }),
      ),
    ).resolves.toEqual({ status: "invalid_payment" });
  });

  test("accepts the largest safe payment amount", async () => {
    await expect(
      completed(
        payment({
          amountMoney: {
            amount: BigInt(Number.MAX_SAFE_INTEGER),
            currency: "USD",
          },
        }),
        order({
          totalMoney: {
            amount: BigInt(Number.MAX_SAFE_INTEGER),
            currency: "USD",
          },
        }),
      ),
    ).resolves.toEqual({
      payments: [
        {
          amountTotal: Number.MAX_SAFE_INTEGER,
          paymentReference: "payment_1",
          refundedAmount: 0,
        },
      ],
      status: "found",
    });
  });

  test("accepts a one-cent completed payment", async () => {
    await expect(
      completed(
        payment({ amountMoney: { amount: BigInt(1), currency: "USD" } }),
        order({ totalMoney: { amount: BigInt(1), currency: "USD" } }),
      ),
    ).resolves.toEqual({
      payments: [
        {
          amountTotal: 1,
          paymentReference: "payment_1",
          refundedAmount: 0,
        },
      ],
      status: "found",
    });
  });

  for (const [name, amount] of [
    ["negative", BigInt(-1)],
    ["unsafe", BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)],
  ] as const) {
    test(`rejects matching ${name} order and payment amounts`, async () => {
      await expect(
        completed(
          payment({ amountMoney: { amount, currency: "USD" } }),
          order({ totalMoney: { amount, currency: "USD" } }),
        ),
      ).resolves.toEqual({ status: "invalid_payment" });
    });
  }

  test("rejects matching empty order and payment currencies", async () => {
    await expect(
      completed(
        payment({ amountMoney: { amount: BigInt(100), currency: "" } }),
        order({ totalMoney: { amount: BigInt(100), currency: "" } }),
      ),
    ).resolves.toEqual({ status: "invalid_payment" });
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
        payments: [
          {
            amountTotal: 100,
            paymentReference: "payment_1",
            refundedAmount,
          },
        ],
        status: "found",
      });
    });
  }

  test("accepts a completed payment with a zero refund", async () => {
    await expect(
      completed(
        payment({
          refundedMoney: { amount: BigInt(0), currency: "USD" },
        }),
      ),
    ).resolves.toEqual({
      payments: [
        {
          amountTotal: 100,
          paymentReference: "payment_1",
          refundedAmount: 0,
        },
      ],
      status: "found",
    });
  });

  for (const [name, invalid] of [
    ["different payment id", payment({ id: "payment_2" })],
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
      await expect(completed(invalid)).resolves.toEqual({
        status: "invalid_payment",
      });
    });
  }

  test("reports no completed payment when the tender cannot be retrieved", async () => {
    await expect(
      completed(null, order({ tenders: [{ paymentId: "payment_1" }] })),
    ).resolves.toEqual({ status: "no_completed_payment" });
  });

  test("reports no completed payment when no tenders exist", async () => {
    await expect(completed(null, order({ tenders: [] }))).resolves.toEqual({
      status: "no_completed_payment",
    });
  });

  test("reports no completed payment when the only tender is pending", async () => {
    await expect(completed(payment({ status: "PENDING" }))).resolves.toEqual({
      status: "no_completed_payment",
    });
  });

  test("rejects a set containing an invalid completed payment", async () => {
    const orderWithTwo = order({
      tenders: [{ paymentId: "payment_a" }, { paymentId: "payment_b" }],
    });
    const retrieved: string[] = [];
    const retrievePayment = (id: string): Promise<SquarePayment> => {
      retrieved.push(id);
      return Promise.resolve(
        id === "payment_b"
          ? payment({
              id,
              orderId: "order_other",
            })
          : payment({ id }),
      );
    };
    await expect(
      findCompletedSquarePayments(retrievePayment)(orderWithTwo),
    ).resolves.toEqual({ status: "invalid_payment" });
    expect(retrieved).toEqual(["payment_b", "payment_a"]);
  });

  test("returns a completed payment whose amount differs from the order total", async () => {
    await expect(
      completed(
        payment({ amountMoney: { amount: BigInt(99), currency: "USD" } }),
      ),
    ).resolves.toEqual({
      payments: [
        {
          amountTotal: 99,
          paymentReference: "payment_1",
          refundedAmount: 0,
        },
      ],
      status: "found",
    });
  });

  test("returns every valid completed split tender", async () => {
    const retrieved: string[] = [];
    const retrievePayment = (id: string): Promise<SquarePayment> => {
      retrieved.push(id);
      return Promise.resolve(
        payment({
          amountMoney: {
            amount: BigInt(id === "payment_a" ? 40 : 60),
            currency: "USD",
          },
          id,
        }),
      );
    };
    await expect(
      findCompletedSquarePayments(retrievePayment)(
        order({
          tenders: [{ paymentId: "payment_a" }, { paymentId: "payment_b" }],
        }),
      ),
    ).resolves.toEqual({
      payments: [
        {
          amountTotal: 60,
          paymentReference: "payment_b",
          refundedAmount: 0,
        },
        {
          amountTotal: 40,
          paymentReference: "payment_a",
          refundedAmount: 0,
        },
      ],
      status: "found",
    });
    expect(retrieved).toEqual(["payment_b", "payment_a"]);
  });

  test("retrieves more than ten completed tenders without truncation", async () => {
    const paymentIds = Array.from(
      { length: 12 },
      (_, index) => `payment_${index}`,
    );
    const retrieved: string[] = [];
    const retrievePayment = (id: string): Promise<SquarePayment> => {
      retrieved.push(id);
      return Promise.resolve(
        payment({
          amountMoney: { amount: BigInt(10), currency: "USD" },
          id,
        }),
      );
    };

    const result = await findCompletedSquarePayments(retrievePayment)(
      order({
        tenders: paymentIds.map((paymentId) => ({ paymentId })),
        totalMoney: { amount: BigInt(120), currency: "USD" },
      }),
    );

    expect(result.status).toBe("found");
    expect(result.status === "found" ? result.payments.length : 0).toBe(12);
    expect(retrieved).toEqual(paymentIds.toReversed());
  });
});
