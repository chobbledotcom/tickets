import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  describeSumup,
  SUMUP_MERCHANT_CODE,
  withSumupMerchantClient,
} from "#test/shared/sumup/fixtures.ts";

describeSumup("SumUp configuration", () => {
  test("returns no client when the API key is absent", () => {
    settings.setForTest({ sumup_api_key: "" });
    expect(sumupApi.getSumupClient()).toBeNull();
  });

  test("creates a client when the API key is configured", () => {
    expect(sumupApi.getSumupClient()).not.toBeNull();
  });

  test("reports a missing API key", async () => {
    settings.setForTest({ sumup_api_key: "" });
    const result = await sumupApi.testSumupConnection();
    expect(result.ok).toBe(false);
    expect(result.apiKey.error).toBe("No SumUp API key configured");
  });

  test("reports a missing merchant code", async () => {
    settings.setForTest({ sumup_merchant_code: "" });
    const result = await sumupApi.testSumupConnection();
    expect(result.ok).toBe(false);
    expect(result.merchant.error).toBe("No merchant code configured");
  });

  test("reports valid credentials, mode, merchant, and currency", () =>
    withSumupMerchantClient(
      () => Promise.resolve({}),
      async () => {
        const result = await sumupApi.testSumupConnection();
        expect(result).toEqual({
          apiKey: { mode: "test", valid: true },
          currency: { code: "GBP", supported: true },
          merchant: {
            configured: true,
            merchantCode: SUMUP_MERCHANT_CODE,
          },
          ok: true,
        });
      },
    ));

  test("fails the check when the site currency is unsupported", async () => {
    settings.setForTest({ currency: "AUD" });
    await withSumupMerchantClient(
      () => Promise.resolve({}),
      async () => {
        const result = await sumupApi.testSumupConnection();
        expect(result.ok).toBe(false);
        expect(result.apiKey.valid).toBe(true);
        expect(result.currency).toEqual({ code: "AUD", supported: false });
      },
    );
  });

  test("reports an unknown mode for an unrecognized key prefix", async () => {
    settings.setForTest({ sumup_api_key: "plainkey" });
    await withSumupMerchantClient(
      () => Promise.resolve({}),
      async () => {
        expect((await sumupApi.testSumupConnection()).apiKey.mode).toBe(
          "unknown",
        );
      },
    );
  });

  test("turns a 401 into API key and account guidance", () =>
    withSumupMerchantClient(
      () => Promise.reject(new Error('401: {"detail":"Unauthorized."}')),
      async () => {
        const error = (await sumupApi.testSumupConnection()).apiKey.error;
        expect(error).toContain("Public API key");
        expect(error).toContain("secret API key");
        expect(error).toContain("same SumUp account");
        expect(error).not.toContain("detail");
      },
    ));

  test("keeps non-401 merchant errors unchanged", () =>
    withSumupMerchantClient(
      () => Promise.reject(new Error("503 Service Unavailable")),
      async () => {
        expect((await sumupApi.testSumupConnection()).apiKey.error).toBe(
          "503 Service Unavailable",
        );
      },
    ));
});
