import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

describe("sumup transactions", () => {
  const { errorSpy } = setupSumupSuite();

  describe("getTransactionStatus", () => {
    test("returns null when merchant code is absent", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withSumupClient(makeSumupClient({}), async () => {
        expect(await sumupApi.getTransactionStatus("txn")).toBeNull();
      });
    });

    test("returns the transaction status", async () => {
      const client = makeSumupClient({
        txnGet: () => Promise.resolve({ status: "SUCCESSFUL" }),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.getTransactionStatus("txn")).toBe("SUCCESSFUL");
      });
    });

    test("reports SumUp's status verbatim, even when it is empty", async () => {
      const client = makeSumupClient({
        txnGet: () => Promise.resolve({ status: "" }),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.getTransactionStatus("txn")).toBe("");
      });
    });

    test("returns null when the status field is absent", async () => {
      const client = makeSumupClient({ txnGet: () => Promise.resolve({}) });
      await withSumupClient(client, async () => {
        expect(await sumupApi.getTransactionStatus("txn")).toBeNull();
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
