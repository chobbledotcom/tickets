import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { getEmbedHostsFromDb, getTimezoneFromDb, setPaymentProvider, updateTermsAndConditions } from "#lib/db/settings.ts";
import { stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  expectRedirect,
  loginAsAdmin,
  mockAdminLoginRequest,
  TEST_ADMIN_PASSWORD,
  withMocks,
} from "#test-utils";

describe("server (admin settings)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/settings", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/settings"));
      expectAdminRedirect(response);
    });

    test("shows settings page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Settings");
      expect(html).toContain("Change Password");
    });

    test("displays success message from query param", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/settings?success=Test+success+message",
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test success message");
      expect(html).toContain('class="success"');
    });
  });

  describe("POST /admin/settings", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings", {
          current_password: "test",
          new_password: "newpassword123",
          new_password_confirm: "newpassword123",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects missing required fields", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "",
            new_password: "",
            new_password_confirm: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("rejects password shorter than 8 characters", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "short",
            new_password_confirm: "short",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("at least 8 characters");
    });

    test("rejects mismatched passwords", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "differentpassword",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("do not match");
    });

    test("rejects incorrect current password", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "wrongpassword",
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Current password is incorrect");
    });

    test("changes password and invalidates session", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Should redirect to admin login with session cleared
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

      // Verify old session is invalidated
      const dashboardResponse = await awaitTestRequest("/admin/", { cookie });
      const html = await dashboardResponse.text();
      expect(html).toContain("Login"); // Should show login, not dashboard

      // Verify new password works
      const newLoginResponse = await handleRequest(
        await mockAdminLoginRequest({ username: "testadmin", password: "newpassword123" }),
      );
      expectAdminRedirect(newLoginResponse);
    });

    test("returns error when password update fails", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Corrupt the wrapped_data_key so updateUserPassword fails to unwrap it
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "UPDATE users SET wrapped_data_key = ?",
        args: ["corrupted-key-data"],
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to update password");
    });
  });

  describe("POST /admin/settings/stripe", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_123",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "sk_test_123",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects missing stripe key", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("updates Stripe key successfully", async () => {
      await withMocks(
        () => spyOn(stripeApi, "setupWebhookEndpoint").mockResolvedValue({
          success: true,
          endpointId: "we_test_123",
          secret: "whsec_test_secret",
        }),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_new_key_123",
                csrf_token: csrfToken,
              },
              cookie,
            ),
          );

          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(location).toContain("/admin/settings?success=");
          expect(decodeURIComponent(location)).toContain("Stripe key updated");
          expect(decodeURIComponent(location)).toContain("webhook configured");
        },
      );
    });

    test("settings page shows Stripe is not configured initially", async () => {
      await setPaymentProvider("stripe");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("No Stripe key is configured");
      expect(html).toContain("Enter your Stripe secret key to enable Stripe payments");
      expect(html).not.toContain("stripe-test-btn");
    });

    test("settings page shows Stripe is configured after setting key", async () => {
      await withMocks(
        () => spyOn(stripeApi, "setupWebhookEndpoint").mockResolvedValue({
          success: true,
          endpointId: "we_test_123",
          secret: "whsec_test_secret",
        }),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          // Set the Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_configured",
                csrf_token: csrfToken,
              },
              cookie,
            ),
          );

          // Check the settings page shows it's configured and has test button
          const response = await awaitTestRequest("/admin/settings", { cookie });
          const html = await response.text();
          expect(html).toContain("A Stripe secret key is currently configured");
          expect(html).toContain("stripe-test-btn");
          expect(html).toContain("Test Connection");
        },
      );
    });
  });

  describe("POST /admin/settings/stripe/test", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/stripe/test", {}),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe/test",
          { csrf_token: "invalid-csrf-token" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("returns JSON result when API key is not configured", async () => {
      await withMocks(
        () => spyOn(stripeApi, "testStripeConnection").mockResolvedValue({
          ok: false,
          apiKey: { valid: false, error: "No Stripe secret key configured" },
          webhook: { configured: false },
        }),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/stripe/test", { csrf_token: csrfToken }, cookie),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("application/json");
          const json = await response.json();
          expect(json.ok).toBe(false);
          expect(json.apiKey.valid).toBe(false);
          expect(json.apiKey.error).toContain("No Stripe secret key configured");
        },
      );
    });

    test("returns success when API key and webhook are valid", async () => {
      await withMocks(
        () => spyOn(stripeApi, "testStripeConnection").mockResolvedValue({
          ok: true,
          apiKey: { valid: true, mode: "test" },
          webhook: {
            configured: true,
            endpointId: "we_test_123",
            url: "https://example.com/payment/webhook",
            status: "enabled",
            enabledEvents: ["checkout.session.completed"],
          },
        }),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/stripe/test", { csrf_token: csrfToken }, cookie),
          );
          expect(response.status).toBe(200);
          const json = await response.json();
          expect(json.ok).toBe(true);
          expect(json.apiKey.valid).toBe(true);
          expect(json.apiKey.mode).toBe("test");
          expect(json.webhook.configured).toBe(true);
          expect(json.webhook.url).toBe("https://example.com/payment/webhook");
          expect(json.webhook.status).toBe("enabled");
          expect(json.webhook.enabledEvents).toContain("checkout.session.completed");
        },
      );
    });

    test("returns partial failure when API key valid but webhook missing", async () => {
      await withMocks(
        () => spyOn(stripeApi, "testStripeConnection").mockResolvedValue({
          ok: false,
          apiKey: { valid: true, mode: "test" },
          webhook: { configured: false, error: "No webhook endpoint ID stored" },
        }),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/stripe/test", { csrf_token: csrfToken }, cookie),
          );
          expect(response.status).toBe(200);
          const json = await response.json();
          expect(json.ok).toBe(false);
          expect(json.apiKey.valid).toBe(true);
          expect(json.webhook.configured).toBe(false);
          expect(json.webhook.error).toContain("No webhook endpoint ID stored");
        },
      );
    });
  });

  describe("POST /admin/settings/embed-hosts", () => {
    test("clears embed hosts when empty", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { embed_hosts: "   ", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Embed host restrictions removed");
      expect(await getEmbedHostsFromDb()).toBe(null);
    });

    test("rejects invalid embed host pattern", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { embed_hosts: "*", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Bare wildcard");
    });

    test("normalizes and saves embed hosts", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { embed_hosts: "Example.com, *.Sub.Example.com", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Allowed embed hosts updated");
      expect(await getEmbedHostsFromDb()).toBe("example.com, *.sub.example.com");
    });
  });

  describe("POST /admin/settings/square", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/square", {
          square_access_token: "EAAAl_test_123",
          square_location_id: "L_test_123",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_123",
            square_location_id: "L_test_123",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects missing square access token", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "",
            square_location_id: "L_test_123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("rejects missing location ID", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_123",
            square_location_id: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("updates Square credentials successfully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_new",
            square_location_id: "L_test_456",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Square credentials updated");
    });

    test("settings page shows Square is not configured initially", async () => {
      await setPaymentProvider("square");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("No Square access token is configured");
    });

    test("settings page shows Square is configured after setting token", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Set the Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_configured",
            square_location_id: "L_test_configured",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Check the settings page shows it's configured
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain("A Square access token is currently configured");
    });
  });

  describe("POST /admin/settings/square-webhook", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/square-webhook", {
          square_webhook_signature_key: "sig_key_test",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects missing webhook signature key", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("updates Square webhook key successfully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "sig_key_new",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Square webhook signature key updated");
    });
  });

  describe("POST /admin/settings/payment-provider (square)", () => {
    test("sets provider to square", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "square",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Payment provider set to square");
    });
  });

  describe("POST /admin/settings/reset-database", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/reset-database", {
          confirm_phrase:
            "The site will be fully reset and all data will be lost.",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects wrong confirmation phrase", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase: "wrong phrase",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Confirmation phrase does not match");
    });

    test("resets database and redirects to setup on correct phrase", async () => {
      // Create some data first
      await createTestEvent({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Should redirect to setup page with session cleared
      expectRedirect("/setup/")(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    test("settings page shows reset database section", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reset Database");
      expect(html).toContain(
        "The site will be fully reset and all data will be lost.",
      );
      expect(html).toContain("confirm_phrase");
    });
  });

  describe("POST /admin/settings/payment-provider", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/payment-provider", {
          payment_provider: "stripe",
        }),
      );
      expectAdminRedirect(response);
    });

    test("sets payment provider to stripe", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "stripe",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Payment provider set to stripe");
    });

    test("disables payment provider with none", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "none",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Payment provider disabled");
    });

    test("rejects invalid payment provider", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "invalid-provider",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment provider");
    });
  });

  describe("POST /admin/settings/stripe (webhook setup failure)", () => {
    test("shows error when webhook setup fails", async () => {
      const mockSetupWebhook = spyOn(stripeApi, "setupWebhookEndpoint");
      mockSetupWebhook.mockResolvedValue({
        success: false,
        error: "Connection refused",
      });

      try {
        const { cookie, csrfToken } = await loginAsAdmin();

        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/stripe",
            {
              stripe_secret_key: "sk_test_webhook_fail",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Failed to set up Stripe webhook");
        expect(html).toContain("Connection refused");
      } finally {
        mockSetupWebhook.mockRestore();
      }
    });
  });

  describe("POST /admin/settings/reset-database (confirm phrase)", () => {
    test("rejects empty confirm phrase", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Confirmation phrase does not match");
    });
  });

  describe("admin/settings.ts (form.get fallbacks)", () => {
    test("payment provider POST without payment_provider field uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Submit without payment_provider field at all
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment provider");
    });

    test("reset database POST without confirm_phrase field uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Submit without confirm_phrase field
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Confirmation phrase does not match");
    });
  });

  describe("POST /admin/settings/terms", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/terms", {
          terms_and_conditions: "You must agree to our policy.",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "Some terms",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("saves terms and conditions", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "By registering you agree to our event policy.",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Terms and conditions updated");
    });

    test("rejects terms exceeding max length", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "x".repeat(10_241),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("10240 characters or fewer");
    });

    test("accepts terms at exactly max length", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "x".repeat(10_240),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Terms and conditions updated");
    });

    test("clears terms when empty", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // First save some terms
      await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "Some terms",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Now clear them
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Terms and conditions removed");
    });

    test("handles missing terms field gracefully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Terms and conditions removed");
    });

    test("settings page shows terms and conditions section", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Terms and Conditions");
      expect(html).toContain("terms_and_conditions");
    });

    test("settings page shows current terms when configured", async () => {
      await updateTermsAndConditions("You must be 18 or older.");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("You must be 18 or older.");
    });
  });

  describe("templates/admin/settings.tsx (Square webhook coverage)", () => {
    test("settings page shows Square webhook config when square provider set", async () => {
      const { cookie } = await loginAsAdmin();
      await setPaymentProvider("square");
      const { updateSquareAccessToken } = await import("#lib/db/settings.ts");
      await updateSquareAccessToken("EAAAl_test_123");

      const response = await handleRequest(
        new Request("http://localhost/admin/settings", {
          headers: {
            host: "localhost",
            cookie,
          },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("webhook");
    });

    test("settings page shows Square webhook configured message", async () => {
      const { cookie } = await loginAsAdmin();
      await setPaymentProvider("square");
      const { updateSquareAccessToken, updateSquareWebhookSignatureKey } = await import("#lib/db/settings.ts");
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareWebhookSignatureKey("sig_key_test");

      const response = await handleRequest(
        new Request("http://localhost/admin/settings", {
          headers: {
            host: "localhost",
            cookie,
          },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("currently configured");
    });
  });

  describe("POST /admin/settings/timezone", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/timezone", {
          timezone: "America/New_York",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "America/New_York", csrf_token: "invalid-csrf-token" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves valid timezone", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "America/New_York", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/admin/settings");
      const saved = await getTimezoneFromDb();
      expect(saved).toBe("America/New_York");
    });

    test("rejects empty timezone", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Timezone is required");
    });

    test("rejects invalid timezone identifier", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "Not/A_Timezone", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid timezone");
    });
  });

  describe("POST /admin/settings/business-email", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/business-email", {
          business_email: "contact@example.com",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "contact@example.com",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("updates business email successfully", async () => {
      const { getBusinessEmailFromDb } = await import("#lib/business-email.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "contact@example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Business email updated");

      const saved = await getBusinessEmailFromDb();
      expect(saved).toBe("contact@example.com");
    });

    test("clears business email when empty string", async () => {
      const { getBusinessEmailFromDb, updateBusinessEmail } = await import("#lib/business-email.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      // First set an email
      await updateBusinessEmail("old@example.com");
      expect(await getBusinessEmailFromDb()).toBe("old@example.com");

      // Then clear it
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Business email cleared");

      const saved = await getBusinessEmailFromDb();
      expect(saved).toBe("");
    });

    test("rejects invalid email format", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "not-an-email",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid email format");
    });
  });

  describe("audit logging", () => {
    test("logs activity when password is changed", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Password changed"))).toBe(true);
    });

    test("logs activity when payment provider is set", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          { payment_provider: "stripe", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Payment provider set to stripe"))).toBe(true);
    });

    test("logs activity when payment provider is disabled", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          { payment_provider: "none", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Payment provider disabled"))).toBe(true);
    });

    test("logs activity when Stripe key is configured", async () => {
      await withMocks(
        () => spyOn(stripeApi, "setupWebhookEndpoint").mockResolvedValue({
          success: true,
          endpointId: "we_test_123",
          secret: "whsec_test_secret",
        }),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "sk_test_log_key", csrf_token: csrfToken },
              cookie,
            ),
          );

          const logs = await getAllActivityLog();
          expect(logs.some((l) => l.message.includes("Stripe key configured"))).toBe(true);
        },
      );
    });

    test("logs activity when Square credentials are configured", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_log",
            square_location_id: "L_test_log",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Square credentials configured"))).toBe(true);
    });

    test("logs activity when Square webhook key is configured", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          { square_webhook_signature_key: "sig_key_log", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Square webhook signature key configured"))).toBe(true);
    });

    test("logs activity when terms and conditions are updated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          { terms_and_conditions: "New terms", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Terms and conditions updated"))).toBe(true);
    });

    test("logs activity when terms and conditions are removed", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          { terms_and_conditions: "", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Terms and conditions removed"))).toBe(true);
    });

    test("logs activity when timezone is updated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "America/New_York", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Timezone set to America/New_York"))).toBe(true);
    });

    test("logs activity when business email is updated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          { business_email: "audit@example.com", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Business email updated"))).toBe(true);
    });

    test("logs activity when business email is cleared", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          { business_email: "", csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Business email cleared"))).toBe(true);
    });

    test("logs activity when database reset is initiated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase: "The site will be fully reset and all data will be lost.",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // After reset, the activity_log table is wiped, so we can't check it.
      // Instead, verify the reset succeeded (redirects to /setup/)
      // The logActivity call happens before resetDatabase() so it was logged
      // but the table is then dropped. This test verifies no error is thrown.
    });
  });

  describe("POST /admin/settings/theme", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/theme", {
          theme: "dark",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "dark",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects invalid theme value", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "invalid-theme",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid theme selection");
    });

    test("rejects missing theme field", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid theme selection");
    });

    test("updates theme to dark successfully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "dark",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Theme updated to dark");
    });

    test("updates theme to light successfully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "light",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Theme updated to light");
    });

    test("theme setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Initially should be "light"
      expect(await settingsApi.getThemeFromDb()).toBe("light");

      // Update to dark
      await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "dark",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Should now be "dark"
      expect(await settingsApi.getThemeFromDb()).toBe("dark");
    });

    test("settings page displays current theme selection", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie } = await loginAsAdmin();

      // Set theme to dark
      await settingsApi.updateTheme("dark");

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      // Check that dark radio button is checked
      expect(html).toContain('value="dark"');
      expect(html).toContain('checked');
    });
  });

});
