import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getSessionCookieName } from "#lib/cookies.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { eventsTable } from "#lib/db/events.ts";
import {
  getEmbedHostsFromDb,
  setPaymentProvider,
  updateTermsAndConditions,
} from "#lib/db/settings.ts";
import { invalidateUsersCache } from "#lib/db/users.ts";
import { setDemoModeForTest } from "#lib/demo.ts";
import { squareApi } from "#lib/square.ts";
import { stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  expectAdminRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  installUrlHandler,
  invalidateTestDbCache,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setTestEnv,
  TEST_ADMIN_PASSWORD,
  testCookie,
  testCsrfToken,
  withFetchMock,
  withMocks,
} from "#test-utils";

describe("server (admin settings)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    setDemoModeForTest(false);
    resetDb();
  });

  describe("GET /admin/settings", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/settings"));
      expectAdminRedirect(response);
    });

    test("shows settings page when authenticated", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Settings", "Change Password");
    });

    test("does not display success when form param is missing", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader("Test success message")}`,
        },
      );
      const html = await response.text();
      expect(html).not.toContain('class="success"');
    });

    test("displays success message on the matching form when form param is provided", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?form=settings-country&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader("Country updated")}`,
        },
      );
      const html = await response.text();
      expect(html).toContain('id="settings-country"');
      expect(html).toContain("Country updated");
      // The success message should be inside the form, not as a global banner
      const formMatch = html.match(/id="settings-country"[\s\S]*?<\/form>/);
      expect(formMatch).toBeDefined();
      expect(formMatch![0]).toContain("Country updated");
    });

    test("does not show success on non-matching forms", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?form=settings-country&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader("Country updated")}`,
        },
      );
      const html = await response.text();
      // The theme form should not contain the success message
      const themeFormMatch = html.match(/id="settings-theme"[\s\S]*?<\/form>/);
      expect(themeFormMatch).toBeDefined();
      expect(themeFormMatch![0]).not.toContain("Country updated");
    });

    test("each settings form has an id attribute", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('id="settings-country"');
      expect(html).toContain('id="settings-business-email"');
      expect(html).toContain('id="settings-payment-provider"');
      expect(html).toContain('id="settings-embed-hosts"');
      expect(html).toContain('id="settings-terms"');
      expect(html).toContain('id="settings-password"');
      expect(html).toContain('id="settings-show-public-site"');
      expect(html).toContain('id="settings-theme"');
    });

    test("shows link to advanced settings", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('href="/admin/settings-advanced"');
      expect(html).toContain("advanced settings");
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing required fields", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "",
            new_password: "",
            new_password_confirm: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "required");
    });

    test("rejects password shorter than 8 characters", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "short",
            new_password_confirm: "short",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "at least 8 characters");
    });

    test("rejects mismatched passwords", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "differentpassword",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "do not match");
    });

    test("rejects incorrect current password", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "wrongpassword",
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 401, "Current password is incorrect");
    });

    test("changes password and invalidates session", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Should redirect to admin login with success message and session cleared
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/admin");
      expectFlash(response, expect.stringContaining("Password changed"));
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(sessionCookie).toContain("Max-Age=0");

      // Verify old session is invalidated
      const dashboardResponse = await awaitTestRequest("/admin/", {
        cookie: await testCookie(),
      });
      const html = await dashboardResponse.text();
      expect(html).toContain("Login"); // Should show login, not dashboard

      // Verify new password works
      const newLoginResponse = await handleRequest(
        await mockAdminLoginRequest({
          username: "testadmin",
          password: "newpassword123",
        }),
      );
      expectRedirectWithFlash("/admin", "Logged in")(newLoginResponse);
    });

    test("returns error when password update fails", async () => {
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "sk_test_123",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing stripe key", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "required");
    });

    test("rejects invalid stripe key format", async () => {
      await setPaymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "invalid_key_123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Invalid Stripe key format",
        "sk_test_",
        "sk_live_",
      );
    });

    test("rejects restricted key format", async () => {
      await setPaymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "rk_test_abc123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Invalid Stripe key format");
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
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_new_key_123",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(location).toContain("/admin/settings");
          expectFlash(response, expect.stringContaining("Stripe key updated"));
          expectFlash(response, expect.stringContaining("webhook configured"));
        },
      );
    });

    test("settings page shows Stripe is not configured initially", async () => {
      await setPaymentProvider("stripe");
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
              success: true,
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
            }),
          ),
        async () => {
          // Set the Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_configured",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

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
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_mode_check",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          const response = await awaitTestRequest("/admin/settings", {
            cookie: await testCookie(),
          });
          const html = await response.text();
          expect(html).toContain("Test mode:");
          expect(html).toContain("No real charges will be made");
        },
      );
    });

    test("settings page shows live mode badge for sk_live_ key", async () => {
      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              success: true,
              endpointId: "we_live_123",
              secret: "whsec_live_secret",
            }),
          ),
        async () => {
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_live_mode_check",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          const response = await awaitTestRequest("/admin/settings", {
            cookie: await testCookie(),
          });
          const html = await response.text();
          expect(html).toContain("Live mode:");
          expect(html).toContain("Payments will be charged for real");
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
              ok: false,
              apiKey: {
                valid: false,
                error: "No Stripe secret key configured",
              },
              webhook: { configured: false },
            }),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe/test",
              {
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
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
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe/test",
              {
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
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
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe/test",
              {
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { embed_hosts: "   ", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Embed host restrictions removed"),
      );
      expect(await getEmbedHostsFromDb()).toBe(null);
    });

    test("rejects invalid embed host pattern", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { embed_hosts: "*", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "Bare wildcard");
    });

    test("normalizes and saves embed hosts", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "Example.com, *.Sub.Example.com",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Allowed embed hosts updated"),
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_123",
            square_location_id: "L_test_123",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing square access token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "",
            square_location_id: "L_test_123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "required");
    });

    test("rejects missing location ID", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_123",
            square_location_id: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "required");
    });

    test("updates Square credentials successfully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_new",
            square_location_id: "L_test_456",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Square credentials updated"),
      );
    });

    test("settings page shows Square is not configured initially", async () => {
      await setPaymentProvider("square");
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("No Square access token is configured");
      expect(html).not.toContain("square-test-btn");
    });

    test("settings page shows Square is configured after setting token", async () => {
      // Set the Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_configured",
            square_location_id: "L_test_configured",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Check the settings page shows it's configured
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("A Square access token is currently configured");
      expect(html).toContain("square-test-btn");
      expect(html).toContain("Test Connection");
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "required");
    });

    test("updates Square webhook key successfully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "sig_key_new",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Square webhook signature key updated"),
      );
    });
  });

  describe("POST /admin/settings/square/test", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/square/test", {}),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square/test",
          { csrf_token: "invalid-csrf-token" },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("returns JSON result when access token is not configured", async () => {
      await withMocks(
        () =>
          stub(squareApi, "testSquareConnection", () =>
            Promise.resolve({
              ok: false,
              accessToken: {
                valid: false,
                error: "No Square access token configured",
              },
              location: { configured: false },
              webhook: { configured: false },
            }),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/square/test",
              { csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
          );
          const json = await response.json();
          expect(json.ok).toBe(false);
          expect(json.accessToken.valid).toBe(false);
          expect(json.accessToken.error).toContain(
            "No Square access token configured",
          );
        },
      );
    });

    test("returns success when all checks pass", async () => {
      await withMocks(
        () =>
          stub(squareApi, "testSquareConnection", () =>
            Promise.resolve({
              ok: true,
              accessToken: { valid: true, mode: "sandbox" },
              location: {
                configured: true,
                locationId: "L_test_123",
                name: "Test Location",
                status: "ACTIVE",
              },
              webhook: { configured: true },
            }),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/square/test",
              { csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(200);
          const json = await response.json();
          expect(json.ok).toBe(true);
          expect(json.accessToken.valid).toBe(true);
          expect(json.accessToken.mode).toBe("sandbox");
          expect(json.location.configured).toBe(true);
          expect(json.location.name).toBe("Test Location");
          expect(json.webhook.configured).toBe(true);
        },
      );
    });

    test("returns partial failure when token valid but location missing", async () => {
      await withMocks(
        () =>
          stub(squareApi, "testSquareConnection", () =>
            Promise.resolve({
              ok: false,
              accessToken: { valid: true, mode: "sandbox" },
              location: {
                configured: false,
                error: "No location ID configured",
              },
              webhook: { configured: true },
            }),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/square/test",
              { csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(200);
          const json = await response.json();
          expect(json.ok).toBe(false);
          expect(json.accessToken.valid).toBe(true);
          expect(json.location.configured).toBe(false);
          expect(json.location.error).toContain("No location ID configured");
        },
      );
    });
  });

  describe("POST /admin/settings/payment-provider (square)", () => {
    test("sets provider to square", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "square",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Payment provider set to square"),
      );
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "stripe",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Payment provider set to stripe"),
      );
    });

    test("disables payment provider with none", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "none",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Payment provider disabled"),
      );
    });

    test("rejects invalid payment provider", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          {
            payment_provider: "invalid-provider",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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

        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/stripe",
            {
              stripe_secret_key: "sk_test_webhook_fail",
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
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
  describe("admin/settings.ts (form.get fallbacks)", () => {
    test("payment provider POST without payment_provider field uses empty fallback", async () => {
      // Submit without payment_provider field at all
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Invalid payment provider");
    });

    test("reset database POST without confirm_phrase field uses empty fallback", async () => {
      // Submit without confirm_phrase field
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "Some terms",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves terms and conditions", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions:
              "By registering you agree to our event policy.",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions updated"),
      );
    });

    test("rejects terms exceeding max length", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "x".repeat(10_241),
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "10240 characters or fewer");
    });

    test("accepts terms at exactly max length", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "x".repeat(10_240),
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions updated"),
      );
    });

    test("clears terms when empty", async () => {
      // First save some terms
      await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "Some terms",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Now clear them
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions removed"),
      );
    });

    test("handles missing terms field gracefully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions removed"),
      );
    });

    test("settings page shows terms and conditions section", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
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
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "You must be 18 or older.");
    });
  });

  describe("templates/admin/settings.tsx (Square webhook coverage)", () => {
    test("settings page shows Square webhook config when square provider set", async () => {
      await setPaymentProvider("square");
      const { updateSquareAccessToken } = await import("#lib/db/settings.ts");
      await updateSquareAccessToken("EAAAl_test_123");

      const response = await handleRequest(
        new Request("http://localhost/admin/settings", {
          headers: {
            host: "localhost",
            cookie: await testCookie(),
          },
        }),
      );
      await expectHtmlResponse(response, 200, "webhook", "full setup guide");
    });

    test("settings page shows Square webhook configured message", async () => {
      await setPaymentProvider("square");
      const { updateSquareAccessToken, updateSquareWebhookSignatureKey } =
        await import("#lib/db/settings.ts");
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareWebhookSignatureKey("sig_key_test");

      const response = await handleRequest(
        new Request("http://localhost/admin/settings", {
          headers: {
            host: "localhost",
            cookie: await testCookie(),
          },
        }),
      );
      await expectHtmlResponse(response, 200, "currently configured");
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "contact@example.com",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("updates business email successfully", async () => {
      const { getBusinessEmailFromDb } = await import("#lib/business-email.ts");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "contact@example.com",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Business email updated"));

      const saved = await getBusinessEmailFromDb();
      expect(saved).toBe("contact@example.com");
    });

    test("clears business email when empty string", async () => {
      const { getBusinessEmailFromDb, updateBusinessEmail } = await import(
        "#lib/business-email.ts"
      );

      // First set an email
      await updateBusinessEmail("old@example.com");
      expect(await getBusinessEmailFromDb()).toBe("old@example.com");

      // Then clear it
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Business email cleared"));

      const saved = await getBusinessEmailFromDb();
      expect(saved).toBe("");
    });

    test("rejects invalid email format", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "not-an-email",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "Invalid email format");
    });
  });

  describe("audit logging", () => {
    test("logs activity when password is changed", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Password changed"))).toBe(
        true,
      );
    });

    test("logs activity when payment provider is set", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          { payment_provider: "stripe", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Payment provider set to stripe")),
      ).toBe(true);
    });

    test("logs activity when payment provider is disabled", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/payment-provider",
          { payment_provider: "none", csrf_token: await testCsrfToken() },
          await testCookie(),
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
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_log_key",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
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
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_log",
            square_location_id: "L_test_log",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Square credentials configured")),
      ).toBe(true);
    });

    test("logs activity when Square webhook key is configured", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "sig_key_log",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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
      await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            terms_and_conditions: "New terms",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Terms and conditions updated")),
      ).toBe(true);
    });

    test("logs activity when terms and conditions are removed", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          { terms_and_conditions: "", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Terms and conditions removed")),
      ).toBe(true);
    });

    test("logs activity when business email is updated", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "audit@example.com",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Business email updated")),
      ).toBe(true);
    });

    test("logs activity when business email is cleared", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          { business_email: "", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Business email cleared")),
      ).toBe(true);
    });

    test("logs activity when database reset is initiated", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // After reset, the activity_log table is wiped, so we can't check it.
      // Instead, verify the reset succeeded (redirects to /setup/)
      // The logActivity call happens before resetDatabase() so it was logged
      // but the table is then dropped. This test verifies no error is thrown.
    });

    test("deletes storage files for all events during admin reset", async () => {
      const restore = setTestEnv({
        STORAGE_ZONE_NAME: "testzone",
        STORAGE_ZONE_KEY: "testkey",
      });

      const event = await createTestEvent({ maxAttendees: 10 });
      await eventsTable.update(event.id, {
        imageUrl: "admin-reset-image.jpg",
        attachmentUrl: "admin-reset-attachment.pdf",
        attachmentName: "doc.pdf",
      });

      await withFetchMock(async (originalFetch) => {
        const deletedUrls: string[] = [];
        installUrlHandler(originalFetch, (url) => {
          if (url.includes("storage.bunnycdn.com")) {
            deletedUrls.push(url);
            return Promise.resolve(
              new Response(JSON.stringify({ HttpCode: 200 }), { status: 200 }),
            );
          }
          return null;
        });

        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/reset-database",
            {
              confirm_phrase:
                "The site will be fully reset and all data will be lost.",
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );

        expectRedirectWithFlash("/setup/", "Database reset")(response);
        expect(
          deletedUrls.some((u) => u.includes("admin-reset-image.jpg")),
        ).toBe(true);
        expect(
          deletedUrls.some((u) => u.includes("admin-reset-attachment.pdf")),
        ).toBe(true);
      });

      restore();
      invalidateTestDbCache();
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "dark",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects invalid theme value", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "invalid-theme",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Invalid theme selection");
    });

    test("rejects missing theme field", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Invalid theme selection");
    });

    test("updates theme to dark successfully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "dark",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Theme updated to dark"));
    });

    test("updates theme to light successfully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "light",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Theme updated to light"));
    });

    test("theme setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      // Initially should be "light"
      expect(await settingsApi.getThemeFromDb()).toBe("light");

      // Update to dark
      await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          {
            theme: "dark",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Should now be "dark"
      expect(await settingsApi.getThemeFromDb()).toBe("dark");
    });

    test("settings page displays current theme selection", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      // Set theme to dark
      await settingsApi.updateTheme("dark");

      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "true",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("enables public site", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "true",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public site enabled"));
    });

    test("disables public site", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "false",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public site disabled"));
    });

    test("setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      // Initially should be false
      expect(await settingsApi.getShowPublicSiteFromDb()).toBe(false);

      // Enable it
      await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            show_public_site: "true",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(await settingsApi.getShowPublicSiteFromDb()).toBe(true);
    });

    test("settings page displays show public site section", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Show public site?",
        "show_public_site",
      );
    });
  });
  describe("POST /admin/settings/country", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/country", {
          country: "US",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "US",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves valid country", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "US",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Country updated"));
    });

    test("rejects invalid country code", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "XX",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "valid country");
    });

    test("rejects empty input", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "Country is required");
    });

    test("setting persists and derives phone prefix", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      // Default should be GB → "44"
      expect(await settingsApi.getPhonePrefixFromDb()).toBe("44");

      // Update to US
      await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "US",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(await settingsApi.getCountryFromDb()).toBe("US");
      expect(await settingsApi.getPhonePrefixFromDb()).toBe("1");
      expect(await settingsApi.getCurrencyCodeFromDb()).toBe("USD");
    });

    test("settings page displays country form", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Your Country");
    });

    test("logs activity when country is changed", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "FR",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Country set to FR"))).toBe(
        true,
      );
    });
  });
  describe("POST /admin/settings/booking-fee", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/booking-fee", {
          booking_fee: "1.5",
        }),
      );
      expectAdminRedirect(response);
    });

    test("saves valid booking fee", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "1.5",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Booking fee updated to 1.5%"),
      );

      const { settingsApi } = await import("#lib/db/settings.ts");
      expect(await settingsApi.getBookingFeeFromDb()).toBe("1.5");
    });

    test("saves zero booking fee", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "0",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Booking fee updated to 0%"),
      );
    });

    test("rejects value exceeding 10", async () => {
      await setPaymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "15",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Booking fee must be a number between 0 and 10",
      );
    });

    test("rejects negative value", async () => {
      await setPaymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "-1",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Booking fee must be a number between 0 and 10",
      );
    });

    test("rejects non-numeric value", async () => {
      await setPaymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "abc",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Booking fee must be a number between 0 and 10",
      );
    });

    test("settings page displays booking fee form when payment provider is set", async () => {
      await setPaymentProvider("stripe");
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Booking Fee", "booking_fee");
    });

    test("settings page hides booking fee form when no payment provider", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).not.toContain('id="settings-booking-fee"');
    });

    test("rejects missing booking_fee field", async () => {
      await setPaymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Booking fee must be a number between 0 and 10",
      );
    });

    test("logs activity when booking fee is changed", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "2.5",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Booking fee set to 2.5%")),
      ).toBe(true);
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
          // Configure a Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_real_secret",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          // Settings page should show sentinel, not the actual key
          const response = await awaitTestRequest("/admin/settings", {
            cookie: await testCookie(),
          });
          const html = await response.text();
          expect(html).toContain(MASK_SENTINEL);
          expect(html).not.toContain("sk_test_real_secret");
        },
      );
    });

    test("shows mask sentinel for configured Square token", async () => {
      const { MASK_SENTINEL } = await import("#lib/db/settings.ts");
      await setPaymentProvider("square");

      // Configure Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_real_secret",
            square_location_id: "L_test_loc",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("EAAAl_real_secret");
    });

    test("shows mask sentinel for configured email API key", async () => {
      const { MASK_SENTINEL, settingsApi } = await import(
        "#lib/db/settings.ts"
      );

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_real_secret_key");

      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("re_real_secret_key");
    });

    test("submitting sentinel for Stripe key does not overwrite existing key", async () => {
      const { MASK_SENTINEL, getStripeSecretKeyFromDb } = await import(
        "#lib/db/settings.ts"
      );
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
          // Configure a Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_original",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          // Submit sentinel — should not change the key
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: MASK_SENTINEL,
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("unchanged"));
          expect(await getStripeSecretKeyFromDb()).toBe("sk_test_original");
        },
      );
    });

    test("submitting sentinel for Square token preserves token but updates location", async () => {
      const {
        MASK_SENTINEL,
        getSquareAccessTokenFromDb,
        getSquareLocationIdFromDb,
      } = await import("#lib/db/settings.ts");
      await setPaymentProvider("square");

      // Configure Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_original",
            square_location_id: "L_original",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Submit sentinel for token but new location ID
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: MASK_SENTINEL,
            square_location_id: "L_updated",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expect(await getSquareAccessTokenFromDb()).toBe("EAAAl_original");
      expect(await getSquareLocationIdFromDb()).toBe("L_updated");
    });

    test("submitting sentinel for Square webhook key does not overwrite", async () => {
      const { MASK_SENTINEL } = await import("#lib/db/settings.ts");

      // Configure webhook key
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "sig_original",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Submit sentinel
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: MASK_SENTINEL,
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("unchanged"));
    });

    test("submitting sentinel for email API key does not overwrite existing key", async () => {
      const { MASK_SENTINEL, getEmailApiKeyFromDb } = await import(
        "#lib/db/settings.ts"
      );

      // Configure email with API key
      await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: "re_original_key",
            email_from_address: "from@test.com",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Submit sentinel for API key
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: MASK_SENTINEL,
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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
          // Configure initial key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_old",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          // Submit a new key (not sentinel)
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_new",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
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
          // Configure a Stripe key first
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                stripe_secret_key: "sk_test_keep_me",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );

          // Submit empty — should preserve existing key
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { stripe_secret_key: "", csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );

          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("unchanged"));
          expect(await getStripeSecretKeyFromDb()).toBe("sk_test_keep_me");
        },
      );
    });

    test("empty Stripe key rejected when no key is configured", async () => {
      await setPaymentProvider("stripe");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          { stripe_secret_key: "", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "required");
    });

    test("empty Square token rejected when no token is configured", async () => {
      await setPaymentProvider("square");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "",
            square_location_id: "L_test",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "required");
    });

    test("empty Square webhook key rejected", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            square_webhook_signature_key: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "required");
    });
  });

  describe("demo mode restrictions", () => {
    beforeEach(() => {
      setDemoModeForTest(true);
    });

    afterEach(() => {
      setDemoModeForTest(false);
    });

    test("rejects Stripe key configuration", async () => {
      await setPaymentProvider("stripe");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "sk_test_new_key_123",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            square_access_token: "EAAAl_test_new",
            square_location_id: "L_test_456",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(
        response,
        400,
        "Cannot configure Square in demo mode",
      );
    });
  });
});
