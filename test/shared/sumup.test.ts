import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { retrieveCheckoutById, sumupApi } from "#shared/sumup.ts";
import {
  makeSumupClient,
  setupSumupSuite,
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
    test("maps major-unit amount to minor units and reads transaction_id", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 12.5,
            checkout_reference: "ref_a",
            currency: "gbp",
            status: "PAID",
            transaction_id: "txn_a",
          }),
      });
      await withSumupClient(client, async () => {
        const result = await retrieveCheckoutById("co_a");
        expect(result).toEqual({
          amountMinor: 1250,
          currency: "GBP",
          overPrecise: false,
          reference: "ref_a",
          status: "PAID",
          transactionId: "txn_a",
        });
      });
    });

    test("falls back to the SUCCESSFUL transaction, skipping failed attempts", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref_b",
            currency: "gbp",
            status: "PAID",
            transactions: [
              { id: "txn_declined", status: "FAILED" },
              { id: "txn_ok", status: "SUCCESSFUL" },
            ],
          }),
      });
      await withSumupClient(client, async () => {
        const result = await retrieveCheckoutById("co_b");
        expect(result!.transactionId).toBe("txn_ok");
      });
    });

    test("defaults the transaction id to empty when nothing succeeded", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref_c",
            currency: "GBP",
            status: "EXPIRED",
          }),
      });
      await withSumupClient(client, async () => {
        const result = await retrieveCheckoutById("co_c");
        expect(result!.transactionId).toBe("");
      });
    });

    test("uses the checkout currency for precision and minor-unit conversion", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 12.5, // one decimal place; JPY has none
            checkout_reference: "ref_jpy",
            currency: "JPY",
            status: "PAID",
          }),
      });
      await withSumupClient(client, async () => {
        // The conversion and precision check follow the checkout's currency
        // (JPY, no minor places), not the site's (GBP, two places).
        expect(await retrieveCheckoutById("co_jpy")).toEqual(
          expect.objectContaining({ amountMinor: 13, overPrecise: true }),
        );
      });
    });

    test("flags a checkout amount more precise than the currency allows", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 12.505, // three decimal places in GBP
            checkout_reference: "ref_overprecise",
            currency: "GBP",
            status: "PAID",
          }),
      });
      await withSumupClient(client, async () => {
        // The raw major-unit amount cannot be rounded silently: the checkout is
        // flagged so the adapter refuses the charge and the callback refunds it.
        expect(await retrieveCheckoutById("co_overprecise")).toEqual(
          expect.objectContaining({ overPrecise: true }),
        );
      });
    });

    test("reads a checkout that carries no amount", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            checkout_reference: "ref_noamount",
            currency: "GBP",
            status: "PAID",
            transaction_id: "txn_noamount",
          }),
      });
      await withSumupClient(client, async () => {
        // Without an amount there is nothing to convert or precision-check —
        // and doing either would throw, which is swallowed here as "no
        // session" and would strand the charge. It is carried as null for the
        // boundary to refuse, so the paid charge still reaches the refund path.
        expect(await retrieveCheckoutById("co_noamount")).toEqual({
          amountMinor: null,
          currency: "GBP",
          overPrecise: false,
          reference: "ref_noamount",
          status: "PAID",
          transactionId: "txn_noamount",
        });
      });
    });

    // A currency the conversion helpers cannot format — absent, blank, or not
    // a real code — must never reach them: Intl throws on one, and the throw
    // would be swallowed here as "no session", stranding a paid charge that
    // should be refunded. The amount converts with the site's currency (GBP,
    // two places) instead, and the raw code is carried for the boundary.
    for (const [name, given, carried] of [
      ["carries no currency", undefined, null],
      ["carries a blank currency", "   ", null],
      ["carries a malformed currency", "GB", "GB"],
    ] as const) {
      test(`reads a checkout that ${name}`, async () => {
        const client = makeSumupClient({
          get: () =>
            Promise.resolve({
              amount: 10,
              checkout_reference: "ref_cur",
              currency: given,
              status: "PAID",
            }),
        });
        await withSumupClient(client, async () => {
          expect(await retrieveCheckoutById("co_cur")).toEqual({
            amountMinor: 1000,
            currency: carried,
            overPrecise: false,
            reference: "ref_cur",
            status: "PAID",
            transactionId: "",
          });
        });
      });
    }
  });
});
