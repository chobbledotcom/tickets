import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

describe("sumup testSumupConnection", () => {
  setupSumupSuite();

  const expectMerchantLookupFails = async (
    errorMessage: string,
    assertError: (error: string | undefined) => void,
  ): Promise<void> => {
    const client = makeSumupClient({
      merchantGet: () => Promise.reject(new Error(errorMessage)),
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

  const withMerchantClient = (fn: () => Promise<void>): Promise<void> => {
    const client = makeSumupClient({
      merchantGet: () => Promise.resolve({}),
    });
    return withSumupClient(client, fn);
  };

  test("reports success with key mode, merchant, and currency", () =>
    withMerchantClient(async () => {
      const result = await sumupApi.testSumupConnection();
      expect(result.ok).toBe(true);
      expect(result.apiKey).toEqual({ mode: "test", valid: true });
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

  test("reports the key mode as unknown for an unrecognized key prefix", async () => {
    settings.setForTest({ sumup_api_key: "plainkey" });
    await withMerchantClient(async () => {
      const result = await sumupApi.testSumupConnection();
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
