import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { MASK_SENTINEL, settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  adminFormPost,
  adminGet,
  assertJson,
  describeWithEnv,
  expectFlash,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/sumup", () => {
    testRequiresAuth("/admin/settings/sumup", {
      body: { sumup_api_key: "sk_test_1", sumup_merchant_code: "MC1" },
      method: "POST",
    });

    test("rejects a missing merchant code", async () => {
      const { response } = await adminFormPost("/admin/settings/sumup", {
        sumup_api_key: "sk_test_1",
        sumup_merchant_code: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merchant code"), false);
    });

    test("rejects a missing API key when none is stored", async () => {
      const { response } = await adminFormPost("/admin/settings/sumup", {
        sumup_api_key: "",
        sumup_merchant_code: "MC1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("rejects configuration when the site currency is unsupported", async () => {
      settings.setForTest({ currency: "AUD" });
      try {
        const { response } = await adminFormPost("/admin/settings/sumup", {
          sumup_api_key: "sk_test_1",
          sumup_merchant_code: "MC1",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("does not support your site currency"),
          false,
        );
      } finally {
        settings.clearTestOverride("currency");
      }
    });

    test("refuses configuration in demo mode", async () => {
      setDemoModeForTest(true);
      const { response } = await adminFormPost("/admin/settings/sumup", {
        sumup_api_key: "sk_test_1",
        sumup_merchant_code: "MC1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("demo mode"), false);
    });

    test("stores new credentials and selects SumUp as the provider", async () => {
      const { response } = await adminFormPost("/admin/settings/sumup", {
        sumup_api_key: "sk_live_new",
        sumup_merchant_code: "MC_new",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("SumUp credentials"));
      expect(settings.paymentProvider).toBe("sumup");
      expect(settings.sumup.merchantCode).toBe("MC_new");
    });

    test("keeps the stored key when the field is left masked", async () => {
      await settings.update.sumup.apiKey("sk_test_keep");
      const { response } = await adminFormPost("/admin/settings/sumup", {
        sumup_api_key: MASK_SENTINEL,
        sumup_merchant_code: "MC_keep",
      });
      expect(response.status).toBe(302);
      expect(settings.sumup.apiKey).toBe("sk_test_keep");
      expect(settings.sumup.merchantCode).toBe("MC_keep");
    });
  });

  describe("settings page (SumUp form)", () => {
    test("shows the not-configured message and hides the test button", async () => {
      await settings.update.paymentProvider("sumup");
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).toContain("No SumUp API key is configured");
      expect(html).not.toContain("sumup-test-btn");
    });

    test("disables browser autocomplete on the SumUp credential fields", async () => {
      await settings.update.paymentProvider("sumup");
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      const inputTag = (name: string): string =>
        html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
      expect(inputTag("sumup_api_key")).toContain('autocomplete="off"');
      expect(inputTag("sumup_merchant_code")).toContain('autocomplete="off"');
    });

    test("shows the configured message and the test button", async () => {
      await adminFormPost("/admin/settings/sumup", {
        sumup_api_key: "sk_test_configured",
        sumup_merchant_code: "MC_configured",
      });
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).toContain("A SumUp API key is currently configured");
      expect(html).toContain("sumup-test-btn");
    });
  });

  describe("POST /admin/settings/sumup/test", () => {
    testRequiresAuth("/admin/settings/sumup/test", {
      body: {},
      method: "POST",
    });

    test("returns the connection test result as JSON", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "testSumupConnection", () =>
            Promise.resolve({
              apiKey: { mode: "test", valid: true },
              currency: { code: "GBP", supported: true },
              merchant: { configured: true, merchantCode: "MC1" },
              ok: true,
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/sumup/test",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(true);
            expect(json.apiKey.valid).toBe(true);
            expect(json.merchant.merchantCode).toBe("MC1");
          });
        },
      );
    });
  });
});
