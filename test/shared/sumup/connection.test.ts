import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

describe("sumup testSumupConnection", () => {
  setupSumupSuite();

  const expectMerchantLookupFails = async (
    refusal: Error,
    assertError: (error: string | undefined) => void,
  ): Promise<void> => {
    const client = makeSumupClient({
      merchantGet: () => Promise.reject(refusal),
    });
    await withSumupClient(client, async () => {
      const result = await sumupApi.testSumupConnection();
      expect(result.ok).toBe(false);
      expect(result.apiKey.valid).toBe(false);
      assertError(result.apiKey.error);
    });
  };

  test("reports a missing API key", async () => {
    settings.setForTest({ sumup_api_key: "" });
    const result = await sumupApi.testSumupConnection();
    expect(result.ok).toBe(false);
    expect(result.apiKey).toEqual({
      error: "No SumUp API key configured",
      valid: false,
    });
    expect(result.merchant).toEqual({ configured: false });
  });

  test("reports a missing merchant code", async () => {
    settings.setForTest({ sumup_merchant_code: "" });
    const result = await sumupApi.testSumupConnection();
    expect(result.ok).toBe(false);
    expect(result.apiKey).toEqual({
      error: "Merchant code is required to verify the key",
      valid: false,
    });
    expect(result.merchant).toEqual({
      configured: false,
      error: "No merchant code configured",
    });
  });

  test("fails loudly when configured credentials cannot create a client", async () => {
    await withSumupClient(null, async () => {
      await expect(sumupApi.testSumupConnection()).rejects.toThrow(
        "Configured SumUp API key did not create a client",
      );
    });
  });

  const withMerchantClient = (fn: () => Promise<void>): Promise<void> => {
    const client = makeSumupClient({
      merchantGet: () => Promise.resolve({}),
    });
    return withSumupClient(client, fn);
  };

  test("reports success with the merchant and currency", () =>
    withMerchantClient(async () => {
      const result = await sumupApi.testSumupConnection();
      expect(result.ok).toBe(true);
      expect(result.apiKey).toEqual({ valid: true });
      expect(result.merchant).toEqual({
        configured: true,
        merchantCode: "MC123",
      });
      expect(result.currency).toEqual({ code: "GBP", supported: true });
    }));

  test("fails overall when the site currency is unsupported", async () => {
    settings.setForTest({ currency: "AUD" });
    await withMerchantClient(async () => {
      const result = await sumupApi.testSumupConnection();
      expect(result.ok).toBe(false);
      expect(result.apiKey.valid).toBe(true);
      expect(result.currency).toEqual({ code: "AUD", supported: false });
    });
  });

  test("names no mode for a real sup_sk_ key, whose account decides", async () => {
    settings.setForTest({ sumup_api_key: "sup_sk_MvxmLOl0" });
    await withMerchantClient(async () => {
      const result = await sumupApi.testSumupConnection();
      expect(result.apiKey).toEqual({ valid: true });
    });
  });

  test("turns a 401 from the merchant lookup into actionable guidance", async () => {
    await expectMerchantLookupFails(
      transportError.answered(
        providerDetail.sumup(),
        401,
        '401: {"detail":"Unauthorized."}',
      ),
      (err) => {
        // The opaque SumUp body is replaced with a hint about the likely causes:
        // the public-vs-secret key mix-up first, then the cross-account mismatch.
        assertStringIncludes(err ?? "", "401");
        assertStringIncludes(err ?? "", "Public API key");
        assertStringIncludes(err ?? "", "secret API key");
        assertStringIncludes(err ?? "", "same SumUp account");
        assert(!(err ?? "").includes("detail"));
      },
    );
  });

  test("passes non-401 merchant lookup errors through unchanged", async () => {
    await expectMerchantLookupFails(
      transportError.answered(
        providerDetail.sumup(),
        503,
        "503 Service Unavailable",
      ),
      (err) => {
        expect(err).toBe("503 Service Unavailable");
      },
    );
  });
});
