import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { type SumupReadResult, sumupApi } from "#shared/sumup.ts";
import {
  describeSumup,
  SUMUP_CHECKOUT_TIME,
  stubSumupClient,
  sumupCheckoutResponse,
  sumupTransactionResponse,
} from "#test/shared/sumup/fixtures.ts";

const useClient = (parts: {
  checkout?: unknown;
  transaction?: unknown;
}): Disposable =>
  stubSumupClient({
    checkouts: { get: () => Promise.resolve(parts.checkout) },
    transactions: { get: () => Promise.resolve(parts.transaction) },
  });

const foundValue = async <Value>(
  result: Promise<SumupReadResult<Value>>,
): Promise<Value> => {
  const read = await result;
  if (read.status !== "found") throw new Error("Expected SumUp resource");
  return read.value;
};

describeSumup("SumUp response boundary", () => {
  test("preserves checkout identity, money, account, status, and time", async () => {
    using _client = useClient({
      checkout: sumupCheckoutResponse({
        status: "PAID",
        transactions: [
          { id: "txn_failed", status: "FAILED" },
          { id: "txn_paid", status: "SUCCESSFUL" },
        ],
      }),
    });
    await expect(
      foundValue(sumupApi.retrieveCheckoutById("co_1")),
    ).resolves.toEqual({
      amountMinor: 1_000,
      createdAt: SUMUP_CHECKOUT_TIME,
      currency: "GBP",
      id: "co_1",
      merchantCode: "MC123",
      reference: "ref",
      status: "PAID",
      transactionId: "txn_paid",
    });
  });

  for (const [name, omitted] of [
    ["id", "id"],
    ["checkout parent", "checkout_reference"],
    ["amount", "amount"],
    ["currency", "currency"],
    ["status", "status"],
    ["merchant account", "merchant_code"],
    ["creation time", "date"],
  ] as const) {
    test(`rejects a checkout with no ${name}`, async () => {
      const checkout = sumupCheckoutResponse();
      delete checkout[omitted];
      using _client = useClient({ checkout });
      await expect(sumupApi.retrieveCheckoutById("co_1")).rejects.toThrow(
        v.ValiError,
      );
    });
  }

  test("rejects an invalid checkout creation time", async () => {
    using _client = useClient({
      checkout: sumupCheckoutResponse({ date: "not-a-time" }),
    });
    await expect(sumupApi.retrieveCheckoutById("co_1")).rejects.toThrow(
      v.ValiError,
    );
  });

  test("rejects a paid checkout without a captured transaction", async () => {
    using _client = useClient({
      checkout: sumupCheckoutResponse({
        status: "PAID",
        transactions: [{ id: "txn_failed", status: "FAILED" }],
      }),
    });
    await expect(sumupApi.retrieveCheckoutById("co_1")).rejects.toThrow(
      "A paid SumUp checkout must have a successful transaction id",
    );
  });

  test("rejects a checkout whose id differs from the requested id", async () => {
    using _client = useClient({
      checkout: sumupCheckoutResponse({ id: "co_other" }),
    });
    await expect(sumupApi.retrieveCheckoutById("co_requested")).rejects.toThrow(
      "SumUp returned a different checkout",
    );
  });

  for (const status of [
    "SUCCESSFUL",
    "CANCELLED",
    "FAILED",
    "PENDING",
  ] as const) {
    test(`preserves the ${status} transaction status`, async () => {
      using _client = useClient({
        transaction: sumupTransactionResponse({ status }),
      });
      const transaction = await foundValue(
        sumupApi.getTransactionStatus("txn_1"),
      );
      expect(transaction.status).toBe(status);
      expect(transaction.refunded).toEqual({ amount: 0, currency: "GBP" });
    });
  }

  for (const [name, omitted] of [
    ["id", "id"],
    ["amount", "amount"],
    ["currency", "currency"],
    ["status", "status"],
    ["merchant account", "merchant_code"],
    ["creation time", "timestamp"],
  ] as const) {
    test(`rejects a transaction with no ${name}`, async () => {
      const transaction = sumupTransactionResponse();
      delete transaction[omitted];
      using _client = useClient({ transaction });
      await expect(sumupApi.getTransactionStatus("txn_1")).rejects.toThrow(
        v.ValiError,
      );
    });
  }

  for (const [name, events, amount] of [
    [
      "partial",
      [{ amount: 4, event_type: "REFUND", id: 41, status: "REFUNDED" }],
      400,
    ],
    [
      "full cumulative",
      [
        { amount: 4, event_type: "REFUND", id: 41, status: "REFUNDED" },
        { amount: 6, event_type: "REFUND", id: 42, status: "SUCCESSFUL" },
      ],
      1_000,
    ],
  ] as const) {
    test(`preserves a ${name} refund`, async () => {
      using _client = useClient({
        transaction: sumupTransactionResponse({
          status: "REFUNDED",
          transaction_events: events,
        }),
      });
      const transaction = await foundValue(
        sumupApi.getTransactionStatus("txn_1"),
      );
      expect(transaction.refunded).toEqual({ amount, currency: "GBP" });
      expect(transaction.refunds.map((refund) => refund.id)).toEqual(
        events.map((event) => event.id),
      );
    });
  }

  test("preserves an authoritative failed refund event", async () => {
    using _client = useClient({
      transaction: sumupTransactionResponse({
        transaction_events: [
          { amount: 10, event_type: "REFUND", id: 43, status: "FAILED" },
        ],
      }),
    });

    const transaction = await foundValue(
      sumupApi.getTransactionStatus("txn_1"),
    );

    expect(transaction.refunds).toEqual([
      {
        amount: { amount: 1_000, currency: "GBP" },
        id: 43,
        status: "failed",
      },
    ]);
    expect(transaction.refunded).toEqual({ amount: 0, currency: "GBP" });
  });

  test("uses compact refund history when detailed history is absent", async () => {
    using _client = useClient({
      transaction: sumupTransactionResponse({
        events: [{ amount: 10, id: 51, status: "REFUNDED", type: "REFUND" }],
        status: "REFUNDED",
      }),
    });
    const transaction = await foundValue(
      sumupApi.getTransactionStatus("txn_1"),
    );
    expect(transaction.refunded).toEqual({ amount: 1_000, currency: "GBP" });
  });

  test("rejects REFUNDED without an authoritative cumulative amount", async () => {
    using _client = useClient({
      transaction: sumupTransactionResponse({ status: "REFUNDED" }),
    });
    await expect(sumupApi.getTransactionStatus("txn_1")).rejects.toThrow(
      "A refunded SumUp transaction needs refund history",
    );
  });

  test("rejects a refund event without an amount", async () => {
    using _client = useClient({
      transaction: sumupTransactionResponse({
        status: "REFUNDED",
        transaction_events: [
          { event_type: "REFUND", id: 1, status: "REFUNDED" },
        ],
      }),
    });
    await expect(sumupApi.getTransactionStatus("txn_1")).rejects.toThrow(
      v.ValiError,
    );
  });

  test("rejects refunds above the transaction amount", async () => {
    using _client = useClient({
      transaction: sumupTransactionResponse({
        status: "REFUNDED",
        transaction_events: [
          { amount: 11, event_type: "REFUND", id: 1, status: "REFUNDED" },
        ],
      }),
    });
    await expect(sumupApi.getTransactionStatus("txn_1")).rejects.toThrow(
      "SumUp refunded amount cannot exceed the transaction amount",
    );
  });

  test("rejects a transaction whose id differs from the requested id", async () => {
    using _client = useClient({
      transaction: sumupTransactionResponse({ id: "txn_other" }),
    });
    await expect(
      sumupApi.getTransactionStatus("txn_requested"),
    ).rejects.toThrow("SumUp returned a different transaction");
  });
});
