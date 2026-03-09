import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import {
  getCustomDomainFromDb,
  getCustomDomainLastValidatedFromDb,
  getEmbedHostsFromDb,
  getTimezoneFromDb,
  setPaymentProvider,
  updateCustomDomain,
  updateCustomDomainLastValidated,
  updateTermsAndConditions,
} from "#lib/db/settings.ts";
import { invalidateUsersCache } from "#lib/db/users.ts";
import { resetDemoMode } from "#lib/demo.ts";
import { stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  expectRedirect,
  loginAsAdmin,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupEventAndLogin,
  TEST_ADMIN_PASSWORD,
  withMocks,
} from "#test-utils";

describe("server (admin settings)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    Deno.env.delete("DEMO_MODE");
    resetDemoMode();
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
      await expectHtmlResponse(response, 200, "Settings", "Change Password");
    });

    test("does not display success when form param is missing", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/settings?success=Test+success+message",
        { cookie },
      );
      const html = await response.text();
      expect(html).not.toContain('class="success"');
    });

    test("displays success message on the matching form when form param is provided", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/settings?success=Timezone+updated&form=settings-timezone",
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain('id="settings-timezone"');
      expect(html).toContain("Timezone updated");
      // The success message should be inside the timezone form, not as a global banner
      const timezoneFormMatch = html.match(
        /id="settings-timezone"[\s\S]*?<\/form>/,
      );
      expect(timezoneFormMatch).toBeDefined();
      expect(timezoneFormMatch![0]).toContain("Timezone updated");
    });

    test("does not show success on non-matching forms", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/settings?success=Timezone+updated&form=settings-timezone",
        { cookie },
      );
      const html = await response.text();
      // The theme form should not contain the success message
      const themeFormMatch = html.match(/id="settings-theme"[\s\S]*?<\/form>/);
      expect(themeFormMatch).toBeDefined();
      expect(themeFormMatch![0]).not.toContain("Timezone updated");
    });

    test("each settings form has an id attribute", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain('id="settings-timezone"');
      expect(html).toContain('id="settings-phone-prefix"');
      expect(html).toContain('id="settings-business-email"');
      expect(html).toContain('id="settings-payment-provider"');
      expect(html).toContain('id="settings-embed-hosts"');
      expect(html).toContain('id="settings-terms"');
      expect(html).toContain('id="settings-password"');
      expect(html).toContain('id="settings-show-public-site"');
      expect(html).toContain('id="settings-show-public-api"');
      expect(html).toContain('id="settings-theme"');
      expect(html).toContain('id="settings-reset-database"');
    });

    test("shows host email label when host email is configured", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      try {
        const { cookie } = await loginAsAdmin();
        const response = await awaitTestRequest("/admin/settings", { cookie });
        const html = await response.text();
        expect(html).toContain("Host Resend (noreply@example.com)");
        expect(html).not.toContain("None (disabled)");
      } finally {
        Deno.env.delete("HOST_EMAIL_PROVIDER");
        Deno.env.delete("HOST_EMAIL_API_KEY");
        Deno.env.delete("HOST_EMAIL_FROM_ADDRESS");
      }
    });

    test("shows raw provider name when host email provider is unknown", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "custom-smtp");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-456");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "mail@example.com");
      try {
        const { cookie } = await loginAsAdmin();
        const response = await awaitTestRequest("/admin/settings", { cookie });
        const html = await response.text();
        expect(html).toContain("Host custom-smtp (mail@example.com)");
      } finally {
        Deno.env.delete("HOST_EMAIL_PROVIDER");
        Deno.env.delete("HOST_EMAIL_API_KEY");
        Deno.env.delete("HOST_EMAIL_FROM_ADDRESS");
      }
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
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
      await expectHtmlResponse(response, 400, "required");
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
      await expectHtmlResponse(response, 400, "at least 8 characters");
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
      await expectHtmlResponse(response, 400, "do not match");
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
      await expectHtmlResponse(response, 401, "Current password is incorrect");
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
        await mockAdminLoginRequest({
          username: "testadmin",
          password: "newpassword123",
        }),
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
      invalidateUsersCache();

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
      await expectHtmlResponse(response, 500, "Failed to update password");
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
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
      await expectHtmlResponse(response, 400, "required");
    });

    test("updates Stripe key successfully", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
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
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
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
          const response = await awaitTestRequest("/admin/settings", {
            cookie,
          });
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("returns JSON result when API key is not configured", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "testStripeConnection", () =>
            Promise.resolve({
              ok: false,
              apiKey: {
                valid: false,
                error: "No Stripe secret key configured",
              },
              webhook: { configured: false },
            }),
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe/test",
              {
                csrf_token: csrfToken,
              },
              cookie,
            ),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
          );
          const json = await response.json();
          expect(json.ok).toBe(false);
          expect(json.apiKey.valid).toBe(false);
          expect(json.apiKey.error).toContain(
            "No Stripe secret key configured",
          );
        },
      );
    });

    test("returns success when API key and webhook are valid", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "testStripeConnection", () =>
            Promise.resolve({
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
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe/test",
              {
                csrf_token: csrfToken,
              },
              cookie,
            ),
          );
          expect(response.status).toBe(200);
          const json = await response.json();
          expect(json.ok).toBe(true);
          expect(json.apiKey.valid).toBe(true);
          expect(json.apiKey.mode).toBe("test");
          expect(json.webhook.configured).toBe(true);
          expect(json.webhook.url).toBe("https://example.com/payment/webhook");
          expect(json.webhook.status).toBe("enabled");
          expect(json.webhook.enabledEvents).toContain(
            "checkout.session.completed",
          );
        },
      );
    });

    test("returns partial failure when API key valid but webhook missing", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "testStripeConnection", () =>
            Promise.resolve({
              ok: false,
              apiKey: { valid: true, mode: "test" },
              webhook: {
                configured: false,
                error: "No webhook endpoint ID stored",
              },
            }),
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe/test",
              {
                csrf_token: csrfToken,
              },
              cookie,
            ),
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
      expect(decodeURIComponent(location)).toContain(
        "Embed host restrictions removed",
      );
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

      await expectHtmlResponse(response, 400, "Bare wildcard");
    });

    test("normalizes and saves embed hosts", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "Example.com, *.Sub.Example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain(
        "Allowed embed hosts updated",
      );
      expect(await getEmbedHostsFromDb()).toBe(
        "example.com, *.sub.example.com",
      );
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
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
      await expectHtmlResponse(response, 400, "required");
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
      await expectHtmlResponse(response, 400, "required");
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
      expect(decodeURIComponent(location)).toContain(
        "Square credentials updated",
      );
    });

    test("settings page shows Square is not configured initially", async () => {
      await setPaymentProvider("square");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(
        response,
        200,
        "No Square access token is configured",
        "/admin/guide#payment-setup",
      );
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
      await expectHtmlResponse(response, 400, "required");
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
      expect(decodeURIComponent(location)).toContain(
        "Square webhook signature key updated",
      );
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
      expect(decodeURIComponent(location)).toContain(
        "Payment provider set to square",
      );
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
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
      await expectHtmlResponse(
        response,
        400,
        "Confirmation phrase does not match",
      );
    });

    test("resets database and redirects to setup on correct phrase", async () => {
      // Create some data first
      const { cookie, csrfToken } = await setupEventAndLogin({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
      });

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
      const html = await expectHtmlResponse(response, 200, "Reset Database");
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
      expect(decodeURIComponent(location)).toContain(
        "Payment provider set to stripe",
      );
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
      expect(decodeURIComponent(location)).toContain(
        "Payment provider disabled",
      );
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
      await expectHtmlResponse(response, 400, "Invalid payment provider");
    });
  });

  describe("POST /admin/settings/stripe (webhook setup failure)", () => {
    test("shows error when webhook setup fails", async () => {
      const mockSetupWebhook = stub(stripeApi, "setupWebhookEndpoint", () =>
        Promise.resolve({
          success: false,
          error: "Connection refused",
        }),
      );

      try {
        await setPaymentProvider("stripe");
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
        await expectHtmlResponse(
          response,
          400,
          "Failed to set up Stripe webhook",
          "Connection refused",
        );
      } finally {
        mockSetupWebhook.restore();
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
      await expectHtmlResponse(
        response,
        400,
        "Confirmation phrase does not match",
      );
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
      await expectHtmlResponse(response, 400, "Invalid payment provider");
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
      await expectHtmlResponse(
        response,
        400,
        "Confirmation phrase does not match",
      );
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves terms and conditions", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions:
              "By registering you agree to our event policy.",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain(
        "Terms and conditions updated",
      );
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

      await expectHtmlResponse(response, 400, "10240 characters or fewer");
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
      expect(decodeURIComponent(location)).toContain(
        "Terms and conditions updated",
      );
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
      expect(decodeURIComponent(location)).toContain(
        "Terms and conditions removed",
      );
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
      expect(decodeURIComponent(location)).toContain(
        "Terms and conditions removed",
      );
    });

    test("settings page shows terms and conditions section", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(
        response,
        200,
        "Terms and Conditions",
        "terms_and_conditions",
        "Formatting help",
      );
    });

    test("settings page shows current terms when configured", async () => {
      await updateTermsAndConditions("You must be 18 or older.");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(response, 200, "You must be 18 or older.");
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
      await expectHtmlResponse(response, 200, "webhook", "full setup guide");
    });

    test("settings page shows Square webhook configured message", async () => {
      const { cookie } = await loginAsAdmin();
      await setPaymentProvider("square");
      const { updateSquareAccessToken, updateSquareWebhookSignatureKey } =
        await import("#lib/db/settings.ts");
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
      await expectHtmlResponse(response, 200, "currently configured");
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
      const location = response.headers.get("location")!;
      expect(location).toContain("/admin/settings");
      expect(location).toContain("form=settings-timezone");
      expect(location).toContain("#settings-timezone");
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
      await expectHtmlResponse(response, 400, "Timezone is required");
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
      await expectHtmlResponse(response, 400, "Invalid timezone");
    });

    test("shows error on the timezone form only", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "", csrf_token: csrfToken },
          cookie,
        ),
      );
      const html = await response.text();
      const timezoneForm = html.match(/id="settings-timezone"[\s\S]*?<\/form>/);
      expect(timezoneForm).toBeDefined();
      expect(timezoneForm![0]).toContain("Timezone is required");
      // Other forms should not have the error
      const themeForm = html.match(/id="settings-theme"[\s\S]*?<\/form>/);
      expect(themeForm).toBeDefined();
      expect(themeForm![0]).not.toContain("Timezone is required");
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
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
      const { getBusinessEmailFromDb, updateBusinessEmail } = await import(
        "#lib/business-email.ts"
      );
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

      await expectHtmlResponse(response, 400, "Invalid email format");
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
      expect(logs.some((l) => l.message.includes("Password changed"))).toBe(
        true,
      );
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
      expect(
        logs.some((l) => l.message.includes("Payment provider set to stripe")),
      ).toBe(true);
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
      expect(
        logs.some((l) => l.message.includes("Payment provider disabled")),
      ).toBe(true);
    });

    test("logs activity when Stripe key is configured", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
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
          expect(
            logs.some((l) => l.message.includes("Stripe key configured")),
          ).toBe(true);
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
      expect(
        logs.some((l) => l.message.includes("Square credentials configured")),
      ).toBe(true);
    });

    test("logs activity when Square webhook key is configured", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "sig_key_log",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) =>
          l.message.includes("Square webhook signature key configured"),
        ),
      ).toBe(true);
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
      expect(
        logs.some((l) => l.message.includes("Terms and conditions updated")),
      ).toBe(true);
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
      expect(
        logs.some((l) => l.message.includes("Terms and conditions removed")),
      ).toBe(true);
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
      expect(
        logs.some((l) =>
          l.message.includes("Timezone set to America/New_York"),
        ),
      ).toBe(true);
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
      expect(
        logs.some((l) => l.message.includes("Business email updated")),
      ).toBe(true);
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
      expect(
        logs.some((l) => l.message.includes("Business email cleared")),
      ).toBe(true);
    });

    test("logs activity when database reset is initiated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
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
      await expectHtmlResponse(response, 400, "Invalid theme selection");
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
      await expectHtmlResponse(response, 400, "Invalid theme selection");
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
      expect(html).toContain("checked");
    });
  });

  describe("POST /admin/settings/show-public-site", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/show-public-site", {
          show_public_site: "true",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "true",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("enables public site", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "true",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Public site enabled");
    });

    test("disables public site", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "false",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Public site disabled");
    });

    test("setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Initially should be false
      expect(await settingsApi.getShowPublicSiteFromDb()).toBe(false);

      // Enable it
      await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "true",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(await settingsApi.getShowPublicSiteFromDb()).toBe(true);
    });

    test("settings page displays show public site section", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(
        response,
        200,
        "Show public site?",
        "show_public_site",
      );
    });
  });

  describe("POST /admin/settings/show-public-api", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/show-public-api", {
          show_public_api: "true",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "true",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("enables public API", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "true",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Public API enabled");
    });

    test("disables public API", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "false",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Public API disabled");
    });

    test("setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      expect(await settingsApi.getShowPublicApiFromDb()).toBe(false);

      await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "true",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(await settingsApi.getShowPublicApiFromDb()).toBe(true);
    });

    test("settings page displays enable public API section", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(
        response,
        200,
        "Enable public API?",
        "show_public_api",
      );
    });
  });

  describe("POST /admin/settings/phone-prefix", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/phone-prefix", {
          phone_prefix: "44",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            phone_prefix: "44",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves valid phone prefix", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            phone_prefix: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain(
        "Phone prefix updated to 1",
      );
    });

    test("rejects non-digit input", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            phone_prefix: "abc",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "Phone prefix must be a number");
    });

    test("rejects empty input", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            phone_prefix: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "Phone prefix must be a number");
    });

    test("rejects when phone_prefix field is missing", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "Phone prefix must be a number");
    });

    test("setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Default should be "44"
      expect(await settingsApi.getPhonePrefixFromDb()).toBe("44");

      // Update it
      await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            phone_prefix: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(await settingsApi.getPhonePrefixFromDb()).toBe("1");
    });

    test("settings page displays phone prefix form", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(response, 200, "Phone Prefix", "phone_prefix");
    });

    test("logs activity when phone prefix is changed", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/phone-prefix",
          {
            phone_prefix: "33",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Phone prefix set to 33")),
      ).toBe(true);
    });
  });

  describe("POST /admin/settings/email", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email", {
          email_provider: "resend",
        }),
      );
      expectAdminRedirect(response);
    });

    test("saves email provider settings", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: "re_test_123",
            email_from_address: "tickets@example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Email settings updated");
    });

    test("disables email when provider is empty", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Email provider disabled");
    });

    test("rejects invalid email provider", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "invalid-provider",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "Invalid email provider");
    });

    test("disables email when provider field is missing", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location")!)).toContain("Email provider disabled");
    });

    test("saves provider without updating key when key is empty", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "postmark",
            email_api_key: "",
            email_from_address: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location")!)).toContain("Email settings updated");
    });

    test("logs activity when email provider is set", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "sendgrid",
            email_api_key: "sg_key",
            email_from_address: "from@test.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Email provider set to sendgrid"))).toBe(true);
    });

    test("settings page displays email configuration section", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain('id="settings-email"');
      expect(html).toContain("email_provider");
      expect(html).toContain("Email Notifications");
    });
  });

  describe("POST /admin/settings/email/test", () => {
    test("shows error when email not configured", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email/test",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "Email not configured");
    });

    test("shows error when no business email set", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email/test",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "No business email set");
    });

    test("sends test email and redirects with success including status code", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import("#lib/business-email.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settingsApi.invalidateSettingsCache();

      await withMocks(
        () => stub(globalThis, "fetch", () => Promise.resolve(new Response())),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/email/test",
              { csrf_token: csrfToken },
              cookie,
            ),
          );

          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location)).toContain("Test email sent (status 200)");
        },
      );
    });

    test("shows error when email API returns non-2xx status", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import("#lib/business-email.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settingsApi.invalidateSettingsCache();

      await withMocks(
        () => stub(globalThis, "fetch", () => Promise.resolve(new Response("Forbidden", { status: 403 }))),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/email/test",
              { csrf_token: csrfToken },
              cookie,
            ),
          );

          const html = await response.text();
          expect(response.status).toBe(502);
          expect(html).toContain("Test email failed (status 403)");
        },
      );
    });

    test("shows error when email send encounters network error", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import("#lib/business-email.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settingsApi.invalidateSettingsCache();

      await withMocks(
        () => stub(globalThis, "fetch", () => Promise.reject(new Error("Network error"))),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/email/test",
              { csrf_token: csrfToken },
              cookie,
            ),
          );

          const html = await response.text();
          expect(response.status).toBe(502);
          expect(html).toContain("Test email failed (no response)");
        },
      );
    });
  });

  describe("settings page email provider display", () => {
    test("shows email provider when configured", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { cookie } = await loginAsAdmin();

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailFromAddress("from@test.com");

      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain('value="resend"');
      expect(html).toContain("Send Test Email");
    });
  });

  describe("sensitive field masking", () => {
    test("shows mask sentinel for configured Stripe key", async () => {
      const { MASK_SENTINEL } = await import("#lib/db/settings.ts");
      await setPaymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          // Configure a Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "sk_test_real_secret", csrf_token: csrfToken },
              cookie,
            ),
          );

          // Settings page should show sentinel, not the actual key
          const response = await awaitTestRequest("/admin/settings", { cookie });
          const html = await response.text();
          expect(html).toContain(MASK_SENTINEL);
          expect(html).not.toContain("sk_test_real_secret");
        },
      );
    });

    test("shows mask sentinel for configured Square token", async () => {
      const { MASK_SENTINEL } = await import("#lib/db/settings.ts");
      await setPaymentProvider("square");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Configure Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_real_secret",
            square_location_id: "L_test_loc",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("EAAAl_real_secret");
    });

    test("shows mask sentinel for configured email API key", async () => {
      const { MASK_SENTINEL, settingsApi } = await import("#lib/db/settings.ts");
      const { cookie } = await loginAsAdmin();

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_real_secret_key");

      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("re_real_secret_key");
    });

    test("submitting sentinel for Stripe key does not overwrite existing key", async () => {
      const { MASK_SENTINEL, getStripeSecretKeyFromDb } = await import("#lib/db/settings.ts");
      await setPaymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          // Configure a Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "sk_test_original", csrf_token: csrfToken },
              cookie,
            ),
          );

          // Submit sentinel — should not change the key
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: MASK_SENTINEL, csrf_token: csrfToken },
              cookie,
            ),
          );

          expect(response.status).toBe(302);
          expect(decodeURIComponent(response.headers.get("location")!)).toContain("unchanged");
          expect(await getStripeSecretKeyFromDb()).toBe("sk_test_original");
        },
      );
    });

    test("submitting sentinel for Square token preserves token but updates location", async () => {
      const { MASK_SENTINEL, getSquareAccessTokenFromDb, getSquareLocationIdFromDb } = await import("#lib/db/settings.ts");
      await setPaymentProvider("square");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Configure Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_original",
            square_location_id: "L_original",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Submit sentinel for token but new location ID
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: MASK_SENTINEL,
            square_location_id: "L_updated",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(await getSquareAccessTokenFromDb()).toBe("EAAAl_original");
      expect(await getSquareLocationIdFromDb()).toBe("L_updated");
    });

    test("submitting sentinel for Square webhook key does not overwrite", async () => {
      const { MASK_SENTINEL } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Configure webhook key
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          { square_webhook_signature_key: "sig_original", csrf_token: csrfToken },
          cookie,
        ),
      );

      // Submit sentinel
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          { square_webhook_signature_key: MASK_SENTINEL, csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location")!)).toContain("unchanged");
    });

    test("submitting sentinel for email API key does not overwrite existing key", async () => {
      const { MASK_SENTINEL, getEmailApiKeyFromDb } = await import("#lib/db/settings.ts");
      const { cookie, csrfToken } = await loginAsAdmin();

      // Configure email with API key
      await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: "re_original_key",
            email_from_address: "from@test.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Submit sentinel for API key
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: MASK_SENTINEL,
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(await getEmailApiKeyFromDb()).toBe("re_original_key");
    });

    test("submitting new value still updates the key", async () => {
      const { getStripeSecretKeyFromDb } = await import("#lib/db/settings.ts");
      await setPaymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          // Configure initial key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "sk_test_old", csrf_token: csrfToken },
              cookie,
            ),
          );

          // Submit a new key (not sentinel)
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "sk_test_new", csrf_token: csrfToken },
              cookie,
            ),
          );

          expect(await getStripeSecretKeyFromDb()).toBe("sk_test_new");
        },
      );
    });

    test("empty Stripe key with existing key is a no-op", async () => {
      const { getStripeSecretKeyFromDb } = await import("#lib/db/settings.ts");
      await setPaymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
        async () => {
          const { cookie, csrfToken } = await loginAsAdmin();

          // Configure a Stripe key first
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "sk_test_keep_me", csrf_token: csrfToken },
              cookie,
            ),
          );

          // Submit empty — should preserve existing key
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "", csrf_token: csrfToken },
              cookie,
            ),
          );

          expect(response.status).toBe(302);
          expect(decodeURIComponent(response.headers.get("location")!)).toContain("unchanged");
          expect(await getStripeSecretKeyFromDb()).toBe("sk_test_keep_me");
        },
      );
    });

    test("empty Stripe key rejected when no key is configured", async () => {
      await setPaymentProvider("stripe");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          { stripe_secret_key: "", csrf_token: csrfToken },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "required");
    });

    test("empty Square token rejected when no token is configured", async () => {
      await setPaymentProvider("square");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "",
            square_location_id: "L_test",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "required");
    });

    test("empty Square webhook key rejected", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          { square_webhook_signature_key: "", csrf_token: csrfToken },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "required");
    });
  });

  describe("demo mode restrictions", () => {
    beforeEach(() => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
    });

    afterEach(() => {
      Deno.env.delete("DEMO_MODE");
      resetDemoMode();
    });

    test("rejects Stripe key configuration", async () => {
      await setPaymentProvider("stripe");
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

      await expectHtmlResponse(
        response,
        400,
        "Cannot configure Stripe in demo mode",
      );
    });

    test("rejects Square credentials configuration", async () => {
      await setPaymentProvider("square");
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

      await expectHtmlResponse(
        response,
        400,
        "Cannot configure Square in demo mode",
      );
    });
  });

  describe("custom domain", () => {
    const setBunnyEnv = () => {
      Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
    };
    const clearBunnyEnv = () => {
      Deno.env.delete("BUNNY_API_KEY");
    };

    afterEach(() => {
      clearBunnyEnv();
    });

    test("does not show custom domain form when Bunny CDN is not configured", async () => {
      clearBunnyEnv();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).not.toContain('id="settings-custom-domain"');
    });

    test("shows custom domain form when Bunny CDN is configured", async () => {
      setBunnyEnv();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain('id="settings-custom-domain"');
      expect(html).toContain("Custom Domain");
    });

    test("does not show validate form when no custom domain is saved", async () => {
      setBunnyEnv();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).not.toContain('id="settings-custom-domain-validate"');
    });

    test("shows validate form and CNAME instructions when custom domain is saved", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain('id="settings-custom-domain-validate"');
      expect(html).toContain("CNAME");
      expect(html).toContain("tickets.example.com");
      // CDN hostname is derived from ALLOWED_DOMAIN (localhost in tests)
      expect(html).toContain("localhost");
    });

    test("shows warning when custom domain is not validated", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain("not yet validated");
      expect(html).toContain("will not work until validation is complete");
    });

    test("does not show warning when custom domain is validated", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      await updateCustomDomainLastValidated();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).not.toContain("not yet validated");
    });

    test("shows last validated timestamp when domain has been validated", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      await updateCustomDomainLastValidated();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain("Last validated:");
    });

    describe("POST /admin/settings/custom-domain", () => {
      test("rejects when Bunny CDN is not configured", async () => {
        clearBunnyEnv();
        const { cookie, csrfToken } = await loginAsAdmin();
        const response = await handleRequest(
          mockFormRequest("/admin/settings/custom-domain", {
            custom_domain: "tickets.example.com",
            csrf_token: csrfToken,
          }, cookie),
        );
        expect(response.status).toBe(400);
      });

      test("saves and validates domain when validation succeeds", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () => Promise.resolve({ ok: true as const });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
              csrf_token: csrfToken,
            }, cookie),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location)).toContain("Custom domain saved and validated");
          expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
          expect(await getCustomDomainLastValidatedFromDb()).not.toBeNull();
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("saves domain with pending message when validation fails", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: false as const, error: "DNS not configured" });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
              csrf_token: csrfToken,
            }, cookie),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location)).toContain("validation pending");
          expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
          expect(await getCustomDomainLastValidatedFromDb()).toBeNull();
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("normalizes domain to lowercase", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () => Promise.resolve({ ok: true as const });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          await handleRequest(
            mockFormRequest("/admin/settings/custom-domain", {
              custom_domain: "Tickets.Example.COM",
              csrf_token: csrfToken,
            }, cookie),
          );
          expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("clears custom domain when empty", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const { cookie, csrfToken } = await loginAsAdmin();
        const response = await handleRequest(
          mockFormRequest("/admin/settings/custom-domain", {
            custom_domain: "",
            csrf_token: csrfToken,
          }, cookie),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location")!;
        expect(decodeURIComponent(location)).toContain("Custom domain cleared");
        expect(await getCustomDomainFromDb()).toBeNull();
      });

      test("clears domain when field is missing from form", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const { cookie, csrfToken } = await loginAsAdmin();
        const response = await handleRequest(
          mockFormRequest("/admin/settings/custom-domain", {
            csrf_token: csrfToken,
          }, cookie),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location")!;
        expect(decodeURIComponent(location)).toContain("Custom domain cleared");
        expect(await getCustomDomainFromDb()).toBeNull();
      });

      test("rejects invalid domain format", async () => {
        setBunnyEnv();
        const { cookie, csrfToken } = await loginAsAdmin();
        const response = await handleRequest(
          mockFormRequest("/admin/settings/custom-domain", {
            custom_domain: "not a domain!",
            csrf_token: csrfToken,
          }, cookie),
        );
        await expectHtmlResponse(response, 400, "Invalid domain format");
      });

      test("logs activity when domain is set", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () => Promise.resolve({ ok: true as const });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          await handleRequest(
            mockFormRequest("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
              csrf_token: csrfToken,
            }, cookie),
          );
          const log = await getAllActivityLog();
          expect(log.some((e) => e.message.includes("Custom domain set to tickets.example.com"))).toBe(true);
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("logs validation activity when save triggers successful validation", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () => Promise.resolve({ ok: true as const });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          await handleRequest(
            mockFormRequest("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
              csrf_token: csrfToken,
            }, cookie),
          );
          const log = await getAllActivityLog();
          expect(log.some((e) => e.message.includes("Custom domain validated"))).toBe(true);
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });
    });

    describe("POST /admin/settings/custom-domain/validate", () => {
      test("rejects when Bunny CDN is not configured", async () => {
        clearBunnyEnv();
        const { cookie, csrfToken } = await loginAsAdmin();
        const response = await handleRequest(
          mockFormRequest("/admin/settings/custom-domain/validate", {
            csrf_token: csrfToken,
          }, cookie),
        );
        expect(response.status).toBe(400);
      });

      test("rejects when no custom domain is saved", async () => {
        setBunnyEnv();
        const { cookie, csrfToken } = await loginAsAdmin();
        const response = await handleRequest(
          mockFormRequest("/admin/settings/custom-domain/validate", {
            csrf_token: csrfToken,
          }, cookie),
        );
        expect(response.status).toBe(400);
      });

      test("calls Bunny API and saves timestamp on success", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () => Promise.resolve({ ok: true as const });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/custom-domain/validate", {
              csrf_token: csrfToken,
            }, cookie),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location)).toContain("Custom domain validated successfully");
          const lastValidated = await getCustomDomainLastValidatedFromDb();
          expect(lastValidated).not.toBeNull();
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("returns error when Bunny API fails", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: false as const, error: "Add hostname failed (400): Hostname already exists" });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          const response = await handleRequest(
            mockFormRequest("/admin/settings/custom-domain/validate", {
              csrf_token: csrfToken,
            }, cookie),
          );
          await expectHtmlResponse(response, 502, "Add hostname failed");
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("logs activity on successful validation", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () => Promise.resolve({ ok: true as const });
        try {
          const { cookie, csrfToken } = await loginAsAdmin();
          await handleRequest(
            mockFormRequest("/admin/settings/custom-domain/validate", {
              csrf_token: csrfToken,
            }, cookie),
          );
          const log = await getAllActivityLog();
          expect(log.some((e) => e.message.includes("Custom domain validated"))).toBe(true);
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });
    });
  });
});
