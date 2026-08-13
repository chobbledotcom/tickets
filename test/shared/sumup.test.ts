/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { APIError } from "@sumup/sdk";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import { checkoutIntent } from "#test-utils/checkout.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

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

  describe("createCheckout", () => {
    test("propagates unexpected checkout client failures", async () => {
      const failure = new TypeError("SumUp connection failed");
      const client = makeSumupClient({
        create: () => Promise.reject(failure),
      });

      await withSumupClient(client, async () => {
        await expect(
          sumupApi.createCheckout(checkoutIntent(), "https://example.com"),
        ).rejects.toBe(failure);
      });
    });
  });

  describe("readCheckoutById", () => {
    /** A paid wire body whose ownership facts agree with the suite's
     *  configured merchant (MC123) and the id the test asks for. */
    const paidWire = (id: string, over: Record<string, unknown> = {}) => ({
      amount: 12.5,
      checkout_reference: "ref_a",
      currency: "gbp",
      id,
      merchant_code: "MC123",
      status: "PAID",
      transaction_id: "txn_a",
      transactions: [
        {
          amount: 12.5,
          currency: "gbp",
          id: "txn_a",
          merchant_code: "MC123",
          status: "SUCCESSFUL",
        },
      ],
      ...over,
    });

    test("reads an owned paid checkout, converting to minor units", async () => {
      const client = makeSumupClient({
        get: () => Promise.resolve(paidWire("co_a")),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_a")).toEqual({
          resource: {
            amountMinor: 1250,
            currency: "GBP",
            reference: "ref_a",
            status: "PAID",
            transactionId: "txn_a",
          },
          status: "found",
        });
      });
    });

    test("converts with the site currency when the checkout carries none", async () => {
      // Wiring proof: the classifier's site-currency fact comes from
      // settings (the suite's site is GBP, two minor places).
      const client = makeSumupClient({
        get: () =>
          Promise.resolve(
            paidWire("co_cur", {
              currency: undefined,
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
        expect(await sumupApi.readCheckoutById("co_cur")).toEqual({
          resource: expect.objectContaining({
            amountMinor: 1250,
            currency: null,
          }),
          status: "found",
        });
      });
    });

    test("refuses a checkout answering for a different id", async () => {
      // Wiring proof: the id the caller asked for reaches the classifier.
      const client = makeSumupClient({
        get: () => Promise.resolve(paidWire("co_other")),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_b")).toEqual({
          reason: "mismatched_id",
          status: "invalid",
        });
      });
    });

    test("refuses a paid checkout that does not name its transaction", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve(paidWire("co_c", { transaction_id: undefined })),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_c")).toEqual({
          reason: "missing_documented_resource",
          status: "invalid",
        });
      });
    });

    test("reads an expired checkout with no transaction id", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref_c",
            currency: "GBP",
            id: "co_exp",
            merchant_code: "MC123",
            status: "EXPIRED",
          }),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_exp")).toEqual({
          resource: expect.objectContaining({
            status: "EXPIRED",
            transactionId: "",
          }),
          status: "found",
        });
      });
    });

    test("reads SumUp's 404 as an authoritative missing", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.reject(new APIError(404, "not found", new Response())),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_gone")).toEqual({
          status: "missing",
        });
        expect(loggedDebug("Checkout read answered 404")).toBe(true);
      });
    });

    test("reads any other SumUp error as unavailable", async () => {
      const client = makeSumupClient({
        get: () =>
          Promise.reject(new APIError(500, "server error", new Response())),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_down")).toEqual({
          reason: "provider_error",
          status: "unavailable",
        });
        expect(loggedDebug("Checkout read answered 500")).toBe(true);
      });
    });

    test("reads a failure before SumUp answered as unavailable", async () => {
      const client = makeSumupClient({
        get: () => Promise.reject(new TypeError("connection reset")),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readCheckoutById("co_net")).toEqual({
          reason: "network_error",
          status: "unavailable",
        });
        expect(loggedDebug("Checkout read failed before SumUp answered")).toBe(
          true,
        );
      });
    });

    test("answers unavailable when no API key is configured", async () => {
      settings.setForTest({ sumup_api_key: "" });
      expect(await sumupApi.readCheckoutById("co_x")).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });

    test("answers unavailable when no merchant code is configured", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      expect(await sumupApi.readCheckoutById("co_x")).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });
  });
});
