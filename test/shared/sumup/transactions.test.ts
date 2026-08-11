import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import { gbp } from "#test-utils/payment-state.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

describe("sumup transactions", () => {
  const { errorSpy } = setupSumupSuite();

  describe("readTransactionMoney", () => {
    test("returns null when merchant code is absent", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withSumupClient(makeSumupClient({}), async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toBeNull();
      });
    });

    test("reports the money taken and keeps only the refund events", async () => {
      const client = makeSumupClient({
        txnGet: () =>
          Promise.resolve({
            amount: 10,
            currency: "GBP",
            status: "SUCCESSFUL",
            transaction_events: [
              { amount: 10, event_type: "PAYOUT", status: "PAID_OUT" },
              { amount: 4, event_type: "REFUND", status: "REFUNDED" },
            ],
          }),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          amount: 10,
          currency: "GBP",
          refundEvents: [{ amount: 4, status: "REFUNDED" }],
        });
      });
    });

    test("reports no refund events when the transaction lists none", async () => {
      const client = makeSumupClient({
        txnGet: () => Promise.resolve(gbp(10)),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          amount: 10,
          currency: "GBP",
          refundEvents: [],
        });
      });
    });

    // A missing amount or currency stays missing: the provider adapter refuses
    // the reading rather than letting a zero stand in for money it never saw.
    test("passes a missing amount and currency through untouched", async () => {
      const client = makeSumupClient({ txnGet: () => Promise.resolve({}) });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          amount: undefined,
          currency: undefined,
          refundEvents: [],
        });
      });
    });
  });

  describe("refundTransaction", () => {
    test("returns false and reports the missing merchant code", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withSumupClient(makeSumupClient({}), async () => {
        expect(await sumupApi.refundTransaction("txn")).toBe(false);
      });
      expect(errorSpy.contains("SumUp merchant code")).toBe(true);
    });

    test("refunds via the transactions API and returns true", async () => {
      const calls: [string, string][] = [];
      const client = makeSumupClient({
        refund: (mc, id) => {
          calls.push([mc, id]);
          return Promise.resolve();
        },
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.refundTransaction("txn_r")).toBe(true);
        expect(calls[0]).toEqual(["MC123", "txn_r"]);
      });
    });

    test("returns false when the client is unavailable", async () => {
      await withSumupClient(null, async () => {
        expect(await sumupApi.refundTransaction("txn")).toBe(false);
      });
    });
  });
});
