// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import type { StripeConnectionTestResult } from "#shared/stripe/endpoints.ts";
import { stripeApi } from "#shared/stripe.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  assertJson,
  expectFlash,
  expectHtml,
  expectHtmlResponse,
  expectRedirect,
  redirectFormId,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { mockFormRequest, withMocks } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";
import {
  activateStripe,
  describeAdminSettings,
  withSuccessfulStripeWebhook,
} from "#test-utils/settings.ts";

// jscpd:ignore-end

describeAdminSettings(() => {
  const stubWebhookAndPostStripe = async (
    secretKey: string,
    body: (response: Response) => Promise<void>,
  ): Promise<void> =>
    withSuccessfulStripeWebhook(async () => {
      const { response } = await adminFormPost("/admin/settings/stripe", {
        stripe_secret_key: secretKey,
      });
      await body(response);
    });

  const postStripeTest = async (
    stubResult: StripeConnectionTestResult,
    assertions: (json: StripeConnectionTestResult) => void,
  ): Promise<void> =>
    withMocks(
      () =>
        stub(stripeApi, "testStripeConnection", () =>
          Promise.resolve(stubResult),
        ),
      async () => {
        const { response } = await adminFormPost("/admin/settings/stripe/test");
        expect(response.headers.get("content-type")).toBe(
          "application/json; charset=utf-8",
        );
        await assertJson(Promise.resolve(response), 200, assertions);
      },
    );

  const expectStripeModeBadge = (
    response: Response,
    mode: "test" | "live",
  ): Promise<string> => {
    const copy =
      mode === "test"
        ? ["Test mode:", "No real charges will be made"]
        : ["Live mode:", "Payments will be charged for real"];
    return expectHtml(response, { contains: copy });
  };

  describe("POST /admin/settings/stripe", () => {
    testRequiresAuth("/admin/settings/stripe", {
      body: {
        stripe_secret_key: "sk_test_123",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            csrf_token: "invalid-csrf-token",
            stripe_secret_key: "sk_test_123",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing stripe key", async () => {
      const { response } = await adminFormPost("/admin/settings/stripe", {
        stripe_secret_key: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("rejects invalid stripe key format", async () => {
      await settings.update.paymentProvider("stripe");
      const { response } = await adminFormPost("/admin/settings/stripe", {
        stripe_secret_key: "invalid_key_123",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid Stripe key format"),
        false,
      );
    });

    test("rejects restricted key format", async () => {
      await settings.update.paymentProvider("stripe");
      const { response } = await adminFormPost("/admin/settings/stripe", {
        stripe_secret_key: "rk_test_abc123",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid Stripe key format"),
        false,
      );
    });

    test("rejects configuration in demo mode", async () => {
      setDemoModeForTest(true);
      try {
        const { response } = await adminFormPost("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_demo",
        });
        expectFlash(response, "Cannot configure Stripe in demo mode", false);
      } finally {
        setDemoModeForTest(false);
      }
    });

    test("updates Stripe key successfully", async () => {
      await stubWebhookAndPostStripe(
        "sk_test_new_key_123",
        async (response) => {
          expect(response.status).toBe(302);
          expectRedirect(response, "/admin/settings");
          expect(redirectFormId(response)).toBe("settings-stripe");
          expectFlash(response, expect.stringContaining("Stripe key updated"));
          expectFlash(response, expect.stringContaining("webhook configured"));
          expect(settings.stripe.webhookSecret).toBe("whsec_test_secret");
          expect(settings.stripe.webhookEndpointId).toBe("we_test_123");
        },
      );
    });

    test("updates credentials without turning sales back on", async () => {
      await activateStripe("whsec_sales_off");
      await settings.update.setPaymentProviderNone();

      await stubWebhookAndPostStripe("sk_test_sales_off", async (response) => {
        expect(response.status).toBe(302);
        expect(settings.paymentProvider).toBeNull();
        expect(settings.lastActivePaymentProvider).toBe("stripe");
        expect(settings.stripe.secretKey).toBe("sk_test_sales_off");
      });
    });

    test("settings page shows Stripe is not configured initially", async () => {
      await settings.update.paymentProvider("stripe");
      await expectHtml(await adminGet("/admin/settings"), {
        contains: [
          "No Stripe key is configured",
          "Enter your Stripe secret key to enable Stripe payments",
          "/admin/guide#payment-setup",
        ],
        notContains: ["stripe-test-btn"],
        status: 200,
      });
    });

    test("settings page shows Stripe is configured after setting key", async () => {
      await stubWebhookAndPostStripe("sk_test_configured", async () => {
        await expectHtml(await adminGet("/admin/settings"), {
          contains: [
            "A Stripe secret key is currently configured",
            "stripe-test-btn",
            "Test Connection",
          ],
        });
      });
    });

    test("settings page shows test mode badge for sk_test_ key", async () => {
      await stubWebhookAndPostStripe("sk_test_mode_check", async () => {
        await expectStripeModeBadge(await adminGet("/admin/settings"), "test");
      });
    });

    test("settings page shows live mode badge for sk_live_ key", async () => {
      await stubWebhookAndPostStripe("sk_live_mode_check", async () => {
        await expectStripeModeBadge(await adminGet("/admin/settings"), "live");
      });
    });

    test("backfills mode indicator when key exists but mode was never stored", async () => {
      // Simulate pre-sentinel setup: key stored directly without mode
      await settings.update.stripe.secretKey("sk_test_backfill");
      await settings.update.paymentProvider("stripe");

      await expectStripeModeBadge(await adminGet("/admin/settings"), "test");
    });
  });

  describe("POST /admin/settings/stripe/test", () => {
    testRequiresAuth("/admin/settings/stripe/test", {
      body: {},
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe/test",
          { csrf_token: "invalid-csrf-token" },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("returns JSON result when API key is not configured", async () => {
      await postStripeTest(
        {
          apiKey: { error: "No Stripe secret key configured", valid: false },
          ok: false,
          webhooks: [],
        },
        (json) => {
          expect(json.ok).toBe(false);
          expect(json.apiKey.valid).toBe(false);
          expect(json.apiKey.error).toContain(
            "No Stripe secret key configured",
          );
        },
      );
    });

    test("returns success when API key and webhooks are valid", async () => {
      await postStripeTest(
        {
          apiKey: { mode: "test", valid: true },
          ok: true,
          ownEndpointId: "we_test_123",
          webhooks: [
            {
              enabledEvents: ["checkout.session.completed"],
              endpointId: "we_test_123",
              status: "enabled",
              url: "https://example.com/payment/webhook",
            },
          ],
        },
        (json) => {
          expect(json.ok).toBe(true);
          expect(json.apiKey.valid).toBe(true);
          expect(json.apiKey.mode).toBe("test");
          expect(json.webhooks).toHaveLength(1);
          expect(json.webhooks[0]!.url).toBe(
            "https://example.com/payment/webhook",
          );
          expect(json.webhooks[0]!.status).toBe("enabled");
          expect(json.webhooks[0]!.enabledEvents).toContain(
            "checkout.session.completed",
          );
        },
      );
    });

    test("returns partial failure when API key valid but no webhooks", async () => {
      await postStripeTest(
        {
          apiKey: { mode: "test", valid: true },
          ok: false,
          webhooks: [],
        },
        (json) => {
          expect(json.ok).toBe(false);
          expect(json.apiKey.valid).toBe(true);
          expect(json.webhooks).toHaveLength(0);
        },
      );
    });
  });

  describe("POST /admin/settings/stripe (webhook setup failure)", () => {
    test("shows error when webhook setup fails", async () => {
      const mockSetupWebhook = stub(stripeApi, "setupWebhookEndpoint", () =>
        Promise.resolve({
          error: "Connection refused",
          success: false,
        }),
      );

      try {
        await settings.update.paymentProvider("stripe");

        const { response } = await adminFormPost("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_webhook_fail",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Failed to set up Stripe webhook"),
          false,
        );
      } finally {
        mockSetupWebhook.restore();
      }
    });

    test("surfaces cleanup failure after saving all new credentials", async () => {
      await activateStripe("whsec_old", "we_old", "sk_test_old_key");
      await settings.update.paymentProvider("square");

      await withMocks(
        () => ({
          cleanupStub: stub(stripeApi, "cleanupOldWebhookEndpoints", () =>
            Promise.reject(new Error("Stripe cleanup failed")),
          ),
          setupStub: stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_new",
              secret: "whsec_new",
              success: true,
            }),
          ),
        }),
        async () => {
          await expect(
            adminFormPost("/admin/settings/stripe", {
              stripe_secret_key: "sk_test_new_key",
            }),
          ).rejects.toThrow("Stripe cleanup failed");
          expect(settings.stripe.secretKey).toBe("sk_test_new_key");
          expect(settings.stripe.webhookEndpointId).toBe("we_new");
          expect(settings.stripe.webhookSecret).toBe("whsec_new");
          expect(settings.paymentProvider).toBe("stripe");
        },
      );
    });

    const rotationCases = [
      {
        cleanup: [
          ["sk_test_old_key", null, null, ["we_old"]],
          [
            "sk_test_new_key",
            "https://localhost/payment/webhook",
            "we_new",
            [],
          ],
        ],
        existingEndpointId: "we_old",
        name: "keeps the recorded endpoint during a key-rotation limit retry",
        newKey: "sk_test_new_key",
        oldKey: "sk_test_old_key",
      },
      {
        cleanup: [
          [
            "sk_test_same_key",
            "https://localhost/payment/webhook",
            "we_new",
            ["we_old"],
          ],
        ],
        existingEndpointId: "we_old",
        name: "cleans a replaced endpoint once when the key is unchanged",
        newKey: "sk_test_same_key",
        oldKey: "sk_test_same_key",
      },
    ];

    for (const entry of rotationCases) {
      test(entry.name, async () => {
        await activateStripe("whsec_old", "we_old", entry.oldKey);
        await withMocks(
          () => ({
            cleanup: stub(stripeApi, "cleanupOldWebhookEndpoints", () =>
              Promise.resolve(),
            ),
            setup: stub(stripeApi, "setupWebhookEndpoint", () =>
              Promise.resolve({
                endpointId: "we_new",
                secret: "whsec_new",
                success: true,
              }),
            ),
          }),
          async ({ cleanup, setup }) => {
            await adminFormPost("/admin/settings/stripe", {
              stripe_secret_key: entry.newKey,
            });
            expect(setup.calls[0]?.args).toEqual([
              entry.newKey,
              "https://localhost/payment/webhook",
              entry.existingEndpointId,
            ]);
            expect(cleanup.calls.map(({ args }) => args)).toEqual(
              entry.cleanup,
            );
          },
        );
      });
    }
  });

  test("logs activity when Stripe key is configured", async () => {
    await stubWebhookAndPostStripe("sk_test_log_key", async () => {
      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Stripe key configured")),
      ).toBe(true);
    });
  });
});
