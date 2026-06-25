import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  adminFormPost,
  assertJson,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  /** Stub `setupWebhookEndpoint` to succeed, then POST the given Stripe key
   *  to the settings form. Returns a promise so the caller can assert on the
   *  effects inside the `withMocks` body. Collapses the repeated webhook-stub
   *  + `adminFormPost` scaffold shared by the test-mode, live-mode, and
   *  activity-log tests. */
  const stubWebhookAndPostStripe = async (
    secretKey: string,
    body: () => Promise<void>,
  ): Promise<void> =>
    withMocks(
      () =>
        stub(stripeApi, "setupWebhookEndpoint", () =>
          Promise.resolve({
            endpointId: "we_test_123",
            secret: "whsec_test_secret",
            success: true,
          }),
        ),
      async () => {
        await adminFormPost("/admin/settings/stripe", {
          stripe_secret_key: secretKey,
        });
        await body();
      },
    );

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

    test("updates Stripe key successfully", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
              success: true,
            }),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/settings/stripe", {
            stripe_secret_key: "sk_test_new_key_123",
          });

          expect(response.status).toBe(302);
          expectRedirect(response, "/admin/settings");
          expectFlash(response, expect.stringContaining("Stripe key updated"));
          expectFlash(response, expect.stringContaining("webhook configured"));
        },
      );
    });

    test("settings page shows Stripe is not configured initially", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "No Stripe key is configured",
        "Enter your Stripe secret key to enable Stripe payments",
        "/admin/guide#payment-setup",
      );
      expect(html).not.toContain("stripe-test-btn");
    });

    test("settings page shows Stripe is configured after setting key", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
              success: true,
            }),
          ),
        async () => {
          // Set the Stripe key
          await adminFormPost("/admin/settings/stripe", {
            stripe_secret_key: "sk_test_configured",
          });

          // Check the settings page shows it's configured and has test button
          const response = await awaitTestRequest("/admin/settings", {
            cookie: await testCookie(),
          });
          const html = await response.text();
          expect(html).toContain("A Stripe secret key is currently configured");
          expect(html).toContain("stripe-test-btn");
          expect(html).toContain("Test Connection");
        },
      );
    });

    test("settings page shows test mode badge for sk_test_ key", async () => {
      await stubWebhookAndPostStripe("sk_test_mode_check", async () => {
        const response = await awaitTestRequest("/admin/settings", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Test mode:");
        expect(html).toContain("No real charges will be made");
      });
    });

    test("settings page shows live mode badge for sk_live_ key", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_live_123",
              secret: "whsec_live_secret",
              success: true,
            }),
          ),
        async () => {
          await adminFormPost("/admin/settings/stripe", {
            stripe_secret_key: "sk_live_mode_check",
          });

          const response = await awaitTestRequest("/admin/settings", {
            cookie: await testCookie(),
          });
          const html = await response.text();
          expect(html).toContain("Live mode:");
          expect(html).toContain("Payments will be charged for real");
        },
      );
    });

    test("backfills mode indicator when key exists but mode was never stored", async () => {
      // Simulate pre-sentinel setup: key stored directly without mode
      await settings.update.stripe.secretKey("sk_test_backfill");
      await settings.update.paymentProvider("stripe");

      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Test mode:");
      expect(html).toContain("No real charges will be made");
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
      await withMocks(
        () =>
          stub(stripeApi, "testStripeConnection", () =>
            Promise.resolve({
              apiKey: {
                error: "No Stripe secret key configured",
                valid: false,
              },
              ok: false,
              webhooks: [],
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/stripe/test",
          );
          expect(response.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(false);
            expect(json.apiKey.valid).toBe(false);
            expect(json.apiKey.error).toContain(
              "No Stripe secret key configured",
            );
          });
        },
      );
    });

    test("returns success when API key and webhooks are valid", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "testStripeConnection", () =>
            Promise.resolve({
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
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/stripe/test",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(true);
            expect(json.apiKey.valid).toBe(true);
            expect(json.apiKey.mode).toBe("test");
            expect(json.webhooks).toHaveLength(1);
            expect(json.webhooks[0].url).toBe(
              "https://example.com/payment/webhook",
            );
            expect(json.webhooks[0].status).toBe("enabled");
            expect(json.webhooks[0].enabledEvents).toContain(
              "checkout.session.completed",
            );
          });
        },
      );
    });

    test("returns partial failure when API key valid but no webhooks", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "testStripeConnection", () =>
            Promise.resolve({
              apiKey: { mode: "test", valid: true },
              ok: false,
              webhooks: [],
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/stripe/test",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(false);
            expect(json.apiKey.valid).toBe(true);
            expect(json.webhooks).toHaveLength(0);
          });
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
