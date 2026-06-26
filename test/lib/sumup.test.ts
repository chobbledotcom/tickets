import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { SumUp } from "@sumup/sdk";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { getSumupCheckout } from "#shared/db/sumup-checkouts.ts";
import {
  createCheckout,
  getTransactionStatus,
  isSumupCurrency,
  refundTransaction,
  retrieveCheckoutById,
  sumupApi,
  testSumupConnection,
} from "#shared/sumup.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";

/** Methods the fake SumUp client may implement for a given test. */
type FakeParts = {
  create?: (body: unknown) => Promise<unknown>;
  get?: (id: string) => Promise<unknown>;
  refund?: (merchantCode: string, id: string) => Promise<void>;
  txnGet?: (merchantCode: string, query: unknown) => Promise<unknown>;
  merchantGet?: (merchantCode: string) => Promise<unknown>;
};

/** Build a minimal fake SumUp client exposing only the methods under test. */
const makeClient = (p: FakeParts): SumUp =>
  ({
    checkouts: { create: p.create, get: p.get },
    merchants: { get: p.merchantGet },
    transactions: { get: p.txnGet, refund: p.refund },
  }) as unknown as SumUp;

/** Stub getSumupClient to return the given fake client (or null). */
const withClient = (client: SumUp | null, body: () => Promise<void>) =>
  withMocks(() => stub(sumupApi, "getSumupClient", () => client), body);

const intent = {
  address: "",
  date: null,
  email: "alice@example.com",
  items: [
    { listingId: 1, name: "Evt", quantity: 2, slug: "evt", unitPrice: 1000 },
  ],
  name: "Alice",
  phone: "",
  special_instructions: "",
};

describe("sumup", () => {
  beforeEach(async () => {
    await createTestDb();
    setEffectiveDomainForTest("example.com");
    settings.setForTest({
      sumup_api_key: "sk_test_abc",
      sumup_merchant_code: "MC123",
    });
  });

  afterEach(() => {
    settings.clearTestOverrides();
    resetDb();
  });

  describe("getSumupClient", () => {
    test("returns null when no API key is configured", () => {
      settings.setForTest({ sumup_api_key: "" });
      expect(sumupApi.getSumupClient()).toBeNull();
    });

    test("returns a client when an API key is configured", () => {
      expect(sumupApi.getSumupClient()).not.toBeNull();
    });
  });

  describe("isSumupCurrency", () => {
    test("accepts SumUp-supported currencies case-insensitively", () => {
      expect(isSumupCurrency("gbp")).toBe(true);
      expect(isSumupCurrency("EUR")).toBe(true);
    });

    test("rejects currencies SumUp cannot charge", () => {
      expect(isSumupCurrency("AUD")).toBe(false);
      expect(isSumupCurrency("JPY")).toBe(false);
    });
  });

  describe("retrieveCheckoutById", () => {
    test("maps major-unit amount to minor units and reads transaction_id", async () => {
      const client = makeClient({
        get: () =>
          Promise.resolve({
            amount: 12.5,
            checkout_reference: "ref_a",
            status: "PAID",
            transaction_id: "txn_a",
          }),
      });
      await withClient(client, async () => {
        const result = await retrieveCheckoutById("co_a");
        expect(result).toEqual({
          amountMinor: 1250,
          reference: "ref_a",
          status: "PAID",
          transactionId: "txn_a",
        });
      });
    });

    test("falls back to the SUCCESSFUL transaction, skipping failed attempts", async () => {
      const client = makeClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref_b",
            status: "PAID",
            transactions: [
              { id: "txn_declined", status: "FAILED" },
              { id: "txn_ok", status: "SUCCESSFUL" },
            ],
          }),
      });
      await withClient(client, async () => {
        const result = await retrieveCheckoutById("co_b");
        expect(result!.transactionId).toBe("txn_ok");
      });
    });

    test("defaults the transaction id to empty when nothing succeeded", async () => {
      const client = makeClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref_c",
            status: "EXPIRED",
          }),
      });
      await withClient(client, async () => {
        const result = await retrieveCheckoutById("co_c");
        expect(result!.transactionId).toBe("");
      });
    });
  });

  describe("createCheckout", () => {
    test("returns null and stores no orphan when merchant code is absent", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      const client = makeClient({ create: () => Promise.resolve({}) });
      await withClient(client, async () => {
        expect(await createCheckout(intent, "http://localhost")).toBeNull();
      });
    });

    test("creates a hosted checkout, converts the total, and persists metadata + id", async () => {
      let sentBody: Record<string, unknown> = {};
      const client = makeClient({
        create: (body) => {
          sentBody = body as Record<string, unknown>;
          return Promise.resolve({
            checkout_reference: sentBody.checkout_reference,
            hosted_checkout_url: "https://pay.sumup.com/x",
            id: "co_created",
            status: "PENDING",
          });
        },
      });
      await withClient(client, async () => {
        const result = await createCheckout(intent, "http://localhost");
        expect(result).not.toBeNull();
        expect(result!.url).toBe("https://pay.sumup.com/x");
        // 2 tickets * 1000 minor units = 2000 minor => 20 major units
        expect(sentBody.amount).toBe(20);
        expect(sentBody.currency).toBe("GBP");
        expect(sentBody.hosted_checkout).toEqual({ enabled: true });
        expect(sentBody.merchant_code).toBe("MC123");
        expect(String(sentBody.redirect_url)).toContain(
          `session_id=${result!.reference}`,
        );
        expect(sentBody.return_url).toBe("https://example.com/payment/webhook");
        // Metadata + SumUp id persisted under the generated reference
        const stored = await getSumupCheckout(result!.reference);
        expect(stored!.metadata.name).toBe("Alice");
        expect(stored!.sumupId).toBe("co_created");
      });
    });

    test("derives the major-unit amount from the configured currency", async () => {
      // CLP is a SumUp-supported zero-decimal currency: 2000 stays 2000.
      settings.setForTest({ currency: "CLP" });
      let sentBody: Record<string, unknown> = {};
      const client = makeClient({
        create: (body) => {
          sentBody = body as Record<string, unknown>;
          return Promise.resolve({
            hosted_checkout_url: "https://pay.sumup.com/y",
            id: "co_clp",
            status: "PENDING",
          });
        },
      });
      await withClient(client, async () => {
        await createCheckout(intent, "http://localhost");
        expect(sentBody.amount).toBe(2000);
        expect(sentBody.currency).toBe("CLP");
      });
    });

    test("returns null when the response lacks an id", async () => {
      const client = makeClient({
        create: () =>
          Promise.resolve({ hosted_checkout_url: "https://pay.sumup.com/z" }),
      });
      await withClient(client, async () => {
        expect(await createCheckout(intent, "http://localhost")).toBeNull();
      });
    });

    test("returns null when the response lacks a hosted_checkout_url", async () => {
      const client = makeClient({
        create: () => Promise.resolve({ id: "co_no_url" }),
      });
      await withClient(client, async () => {
        expect(await createCheckout(intent, "http://localhost")).toBeNull();
      });
    });

    test("returns null when the client is unavailable", async () => {
      await withClient(null, async () => {
        expect(await createCheckout(intent, "http://localhost")).toBeNull();
      });
    });
  });

  describe("getTransactionStatus", () => {
    test("returns null when merchant code is absent", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withClient(makeClient({}), async () => {
        expect(await getTransactionStatus("txn")).toBeNull();
      });
    });

    test("returns the transaction status", async () => {
      const client = makeClient({
        txnGet: () => Promise.resolve({ status: "SUCCESSFUL" }),
      });
      await withClient(client, async () => {
        expect(await getTransactionStatus("txn")).toBe("SUCCESSFUL");
      });
    });

    test("returns null when the status field is absent", async () => {
      const client = makeClient({ txnGet: () => Promise.resolve({}) });
      await withClient(client, async () => {
        expect(await getTransactionStatus("txn")).toBeNull();
      });
    });
  });

  describe("refundTransaction", () => {
    test("returns false when merchant code is absent", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withClient(makeClient({}), async () => {
        expect(await refundTransaction("txn")).toBe(false);
      });
    });

    test("refunds via the transactions API and returns true", async () => {
      const calls: [string, string][] = [];
      const client = makeClient({
        refund: (mc, id) => {
          calls.push([mc, id]);
          return Promise.resolve();
        },
      });
      await withClient(client, async () => {
        expect(await refundTransaction("txn_r")).toBe(true);
        expect(calls[0]).toEqual(["MC123", "txn_r"]);
      });
    });

    test("returns false when the client is unavailable", async () => {
      await withClient(null, async () => {
        expect(await refundTransaction("txn")).toBe(false);
      });
    });
  });

  describe("testSumupConnection", () => {
    const expectMerchantLookupFails = async (
      errorMessage: string,
      assertError: (error: string | undefined) => void,
    ): Promise<void> => {
      const client = makeClient({
        merchantGet: () => Promise.reject(new Error(errorMessage)),
      });
      await withClient(client, async () => {
        const result = await testSumupConnection();
        expect(result.ok).toBe(false);
        expect(result.apiKey.valid).toBe(false);
        assertError(result.apiKey.error);
      });
    };

    test("reports a missing API key", async () => {
      settings.setForTest({ sumup_api_key: "" });
      const result = await testSumupConnection();
      expect(result.ok).toBe(false);
      expect(result.apiKey.error).toBe("No SumUp API key configured");
    });

    test("reports a missing merchant code", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      const result = await testSumupConnection();
      expect(result.ok).toBe(false);
      expect(result.merchant.error).toBe("No merchant code configured");
    });

    test("reports success with key mode, merchant, and currency", async () => {
      const client = makeClient({ merchantGet: () => Promise.resolve({}) });
      await withClient(client, async () => {
        const result = await testSumupConnection();
        expect(result.ok).toBe(true);
        expect(result.apiKey).toEqual({ mode: "test", valid: true });
        expect(result.merchant).toEqual({
          configured: true,
          merchantCode: "MC123",
        });
        expect(result.currency).toEqual({ code: "GBP", supported: true });
      });
    });

    test("fails overall when the site currency is unsupported", async () => {
      settings.setForTest({ currency: "AUD" });
      const client = makeClient({ merchantGet: () => Promise.resolve({}) });
      await withClient(client, async () => {
        const result = await testSumupConnection();
        expect(result.ok).toBe(false);
        expect(result.apiKey.valid).toBe(true);
        expect(result.currency).toEqual({ code: "AUD", supported: false });
      });
    });

    test("reports the key mode as unknown for an unrecognized key prefix", async () => {
      settings.setForTest({ sumup_api_key: "plainkey" });
      const client = makeClient({ merchantGet: () => Promise.resolve({}) });
      await withClient(client, async () => {
        const result = await testSumupConnection();
        expect(result.apiKey.mode).toBe("unknown");
      });
    });

    test("turns a 401 from the merchant lookup into actionable guidance", async () => {
      await expectMerchantLookupFails(
        '401: {"detail":"Unauthorized."}',
        (err) => {
          // The opaque SumUp body is replaced with a hint about the likely causes:
          // the public-vs-secret key mix-up first, then the cross-account mismatch.
          expect(err).toContain("401");
          expect(err).toContain("Public API key");
          expect(err).toContain("secret API key");
          expect(err).toContain("same SumUp account");
          expect(err).not.toContain("detail");
        },
      );
    });

    test("passes non-401 merchant lookup errors through unchanged", async () => {
      await expectMerchantLookupFails("503 Service Unavailable", (err) => {
        expect(err).toBe("503 Service Unavailable");
      });
    });
  });
});
