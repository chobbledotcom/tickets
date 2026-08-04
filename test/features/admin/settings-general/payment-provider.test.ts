import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  redirectFormId,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/payment-provider (square)", () => {
    test("sets provider to square", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "square" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Payment provider set to square");
    });
  });

  describe("POST /admin/settings/payment-provider", () => {
    testRequiresAuth("/admin/settings/payment-provider", {
      body: {
        payment_provider: "stripe",
      },
      method: "POST",
    });

    test("sets payment provider to stripe", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "stripe" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, "Payment provider set to stripe");
      expect(settings.paymentProvider).toBe("stripe");
      expect(redirectFormId(response)).toBe("settings-payment-provider");
    });

    test("disables payment provider with none", async () => {
      await adminFormPost("/admin/settings/payment-provider", {
        payment_provider: "stripe",
      });
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "none" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, "Payment provider disabled");
      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBe("none");
      expect(settings.lastActivePaymentProvider).toBe("stripe");
    });

    test("refuses a provider that cannot take the site currency", async () => {
      settings.setForTest({ currency: "JPY" });
      try {
        const { response } = await adminFormPost(
          "/admin/settings/payment-provider",
          { payment_provider: "sumup" },
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          "SumUp cannot take payments in JPY. Choose a different payment provider.",
          false,
        );
        expect(settings.paymentProvider).not.toBe("sumup");
      } finally {
        settings.clearTestOverride("currency");
      }
    });

    test("rejects invalid payment provider", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "invalid-provider" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid payment provider"),
        false,
      );
    });

    test("payment provider POST without payment_provider field uses empty fallback", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid payment provider"),
        false,
      );
    });

    test("requires ambiguous existing payments to be recovered before enabling sales", async () => {
      await settings.update.stripe.secretKey("sk_test_ambiguous");
      await settings.update.square.accessToken("square-ambiguous");
      await settings.update.setPaymentProviderNone();

      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "stripe" },
      );

      expectFlash(
        response,
        "Choose the provider for existing payments before enabling new sales.",
        false,
      );
      expect(settings.paymentProvider).toBeNull();
    });

    test("recovers the provider for old payments without enabling sales", async () => {
      await settings.update.stripe.secretKey("sk_test_recovery");
      await settings.update.square.accessToken("square-recovery");
      await settings.update.setPaymentProviderNone();

      const { response } = await adminFormPost(
        "/admin/settings/payment-provider-recovery",
        { existing_payment_provider: "stripe" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Existing payment provider set to Stripe.");
      expect(settings.paymentProviderSetting).toBe("none");
      expect(settings.paymentProvider).toBeNull();
      expect(settings.lastActivePaymentProvider).toBe("stripe");
      expect(redirectFormId(response)).toBe(
        "settings-payment-provider-recovery",
      );

      await adminFormPost("/admin/settings/payment-provider", {
        payment_provider: "stripe",
      });
      expect(settings.paymentProvider).toBe("stripe");
    });

    test("rejects recovery through a provider without saved credentials", async () => {
      await settings.update.stripe.secretKey("sk_test_recovery");
      await settings.update.setPaymentProviderNone();

      const { response } = await adminFormPost(
        "/admin/settings/payment-provider-recovery",
        { existing_payment_provider: "square" },
      );

      expectFlash(response, "Choose a provider with saved credentials.", false);
      expect(settings.paymentProvider).toBeNull();
      expect(settings.lastActivePaymentProvider).toBeNull();
    });

    test("rejects a stale recovery post after sales were enabled", async () => {
      await settings.update.stripe.secretKey("sk_test_active");
      await settings.update.paymentProvider("stripe");
      await settings.update.square.accessToken("square-stale-recovery");

      const { response } = await adminFormPost(
        "/admin/settings/payment-provider-recovery",
        { existing_payment_provider: "square" },
      );

      expectFlash(
        response,
        "Provider recovery is unavailable while new sales are on.",
        false,
      );
      expect(settings.paymentProvider).toBe("stripe");
      expect(settings.lastActivePaymentProvider).toBe("stripe");
    });
  });

  test("logs activity when payment provider is set", async () => {
    await adminFormPost("/admin/settings/payment-provider", {
      payment_provider: "stripe",
    });

    const logs = await getAllActivityLog();
    expect(
      logs.some((l) => l.message === "Payment provider set to stripe"),
    ).toBe(true);
  });

  test("logs activity when payment provider is disabled", async () => {
    await adminFormPost("/admin/settings/payment-provider", {
      payment_provider: "none",
    });

    const logs = await getAllActivityLog();
    expect(logs.some((l) => l.message === "Payment provider disabled")).toBe(
      true,
    );
  });
});
