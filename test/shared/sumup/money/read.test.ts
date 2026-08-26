import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import { readSumupCharge } from "#shared/sumup/money.ts";
import type { SumupTransactionMoney } from "#shared/sumup/transaction.ts";
import { sumupApi } from "#shared/sumup.ts";
import { gbp } from "#test-utils/payment-state.ts";

type RefundEvent = SumupTransactionMoney["refundEvents"][number];

/** A £10 SumUp transaction, in the major units SumUp states money in. */
const transaction = (
  refundEvents: RefundEvent[],
  values: Partial<SumupTransactionMoney> = {},
): ProviderRead<SumupTransactionMoney> => ({
  resource: { amount: 10, currency: "GBP", refundEvents, ...values },
  status: "found",
});

/** What the charge reader made of one transaction read. */
const readCharge = async (
  read: ProviderRead<SumupTransactionMoney>,
): Promise<ProviderRead<ChargeMoney>> => {
  using _asked = stub(sumupApi, "readTransactionMoney", () =>
    Promise.resolve(read),
  );
  return await readSumupCharge("txn_9");
};

/** The £10 charge those refunds add up to, with nothing confirmed back:
 *  SumUp keeps no cumulative total, so the events are the whole account. */
const charge = (
  refunds: ChargeMoney["refunds"],
): ProviderRead<ChargeMoney> => ({
  resource: { captured: gbp(1000), confirmedRefunded: gbp(0), refunds },
  status: "found",
});

const MALFORMED = { reason: "malformed_money", status: "invalid" } as const;
const UNSUPPORTED = {
  reason: "unsupported_status",
  status: "invalid",
} as const;

describe("reading SumUp transaction money as charge money", () => {
  test("asks SumUp about the transaction it was given", async () => {
    using asked = stub(sumupApi, "readTransactionMoney", () =>
      Promise.resolve(transaction([])),
    );
    await readSumupCharge("txn_9");
    expect(asked.calls.map((call) => call.args)).toEqual([["txn_9"]]);
  });

  test("reads a transaction with no refund events as nothing back", async () => {
    expect(await readCharge(transaction([]))).toEqual(charge([]));
  });

  for (const [status, expected] of [
    ["REFUNDED", { amount: gbp(400), status: "completed" }],
    ["SUCCESSFUL", { amount: gbp(400), status: "completed" }],
    ["PENDING", { amount: gbp(400), status: "pending" }],
    ["SCHEDULED", { amount: gbp(400), status: "pending" }],
    [
      "FAILED",
      { amount: gbp(400), reason: "provider_failed", status: "failed" },
    ],
  ] as const) {
    test(`reads a ${status} event as a ${expected.status} refund`, async () => {
      expect(await readCharge(transaction([{ amount: 4, status }]))).toEqual(
        charge([expected]),
      );
    });
  }

  // PAID_OUT and RECONCILED are SumUp's own bookkeeping, not money going back,
  // so a refund event wearing one is refused rather than counted as nothing.
  for (const status of ["PAID_OUT", "RECONCILED", "WAT", undefined]) {
    test(`refuses a refund event that is ${status ?? "missing its status"}`, async () => {
      expect(await readCharge(transaction([{ amount: 4, status }]))).toEqual(
        UNSUPPORTED,
      );
    });
  }

  for (const [name, amount] of [
    ["no amount", undefined],
    ["an amount that is not a real number", Number.POSITIVE_INFINITY],
    ["more decimals than the currency has", 4.001],
  ] as const) {
    test(`refuses a refund event with ${name}`, async () => {
      expect(
        await readCharge(transaction([{ amount, status: "REFUNDED" }])),
      ).toEqual(MALFORMED);
    });
  }

  for (const [name, values] of [
    ["no amount", { amount: undefined }],
    ["more decimals than the currency has", { amount: 10.001 }],
    ["a currency that is not a currency", { currency: "GB" }],
    ["no currency", { currency: undefined }],
  ] as const satisfies readonly (readonly [
    string,
    Partial<SumupTransactionMoney>,
  ])[]) {
    test(`refuses transaction money with ${name}`, async () => {
      expect(await readCharge(transaction([], values))).toEqual(MALFORMED);
    });
  }

  test("accepts a currency SumUp states in lower case", async () => {
    expect(
      await readCharge(
        transaction([{ amount: 4, status: "REFUNDED" }], { currency: "gbp" }),
      ),
    ).toEqual(charge([{ amount: gbp(400), status: "completed" }]));
  });

  test("reads every refund event on the transaction", async () => {
    expect(
      await readCharge(
        transaction([
          { amount: 4, status: "REFUNDED" },
          { amount: 6, status: "PENDING" },
        ]),
      ),
    ).toEqual(
      charge([
        { amount: gbp(400), status: "completed" },
        { amount: gbp(600), status: "pending" },
      ]),
    );
  });

  test("refuses the whole reading when one event of several is unreadable", async () => {
    expect(
      await readCharge(
        transaction([
          { amount: 4, status: "REFUNDED" },
          { amount: 6, status: "WAT" },
        ]),
      ),
    ).toEqual(UNSUPPORTED);
  });

  for (const read of [
    { status: "missing" },
    { reason: "rate_limited", status: "unavailable" },
    { reason: "malformed_response", status: "invalid" },
  ] as const satisfies ProviderRead<SumupTransactionMoney>[]) {
    test(`passes on a transaction read that is ${read.status}`, async () => {
      expect(await readCharge(read)).toEqual(read);
    });
  }
});
