import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { retrieveCheckoutById, sumupApi } from "#shared/sumup.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  sumupCheckoutResponse,
  withSumupClient,
} from "#test-utils/sumup.ts";

describe("sumup", () => {
  const { loggedDebug } = setupSumupSuite();

  describe("getSumupClient", () => {
    test("returns null and says why when no API key is configured", () => {
      settings.setForTest({ sumup_api_key: "" });
      expect(sumupApi.getSumupClient()).toBeNull();
      expect(loggedDebug("No API key configured, cannot create client")).toBe(
        true,
      );
    });

    test("returns a client when an API key is configured", () => {
      expect(sumupApi.getSumupClient()).not.toBeNull();
    });
  });

  describe("retrieveCheckoutById", () => {
    test("returns null when the client is unavailable", async () => {
      await withSumupClient(null, async () => {
        expect(await retrieveCheckoutById("co_missing")).toBeNull();
      });
    });

    test("maps major-unit amount to minor units and reads transaction_id", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve(
            sumupCheckoutResponse({
              amount: 12.5,
              checkout_reference: "ref_a",
              currency: "GBP",
              transaction_id: "txn_a",
              transactions: [
                {
                  amount: 12.5,
                  currency: "GBP",
                  id: "txn_a",
                  merchant_code: "MC123",
                  status: "SUCCESSFUL",
                },
              ],
            }),
          ),
      });
      await withSumupClient(client, async () => {
        const result = await retrieveCheckoutById("co_a");
        expect(result).toEqual({
          amountMinor: 1250,
          currency: "GBP",
          reference: "ref_a",
          status: "PAID",
          transactionId: "txn_a",
        });
      });
    });

    test("uses an empty transaction id for a failed checkout", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref_c",
            currency: "GBP",
            id: "checkout-failed",
            merchant_code: "MC123",
            status: "FAILED",
            transactions: [
              {
                amount: 10,
                currency: "GBP",
                id: "transaction-failed",
                merchant_code: "MC123",
                status: "FAILED",
              },
            ],
          }),
      });
      await withSumupClient(client, async () => {
        const result = await retrieveCheckoutById("co_c");
        expect(result!.transactionId).toBe("");
      });
    });
  });
});
