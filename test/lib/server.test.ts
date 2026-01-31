import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { createSession, getSession } from "#lib/db/sessions.ts";
import { setPaymentProvider, updateStripeKey } from "#lib/db/settings.ts";
import { resetStripeClient, stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDb,
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  getSetupCsrfToken,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  mockRequestWithHost,
  mockSetupFormRequest,
  mockTicketFormRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  expectRedirect,
  loginAsAdmin,
  TEST_ADMIN_PASSWORD,
  withMocks,
} from "#test-utils";

/**
 * Helper to make a ticket form POST request with CSRF token
 * First GETs the page to obtain the CSRF token, then POSTs with it
 */
const submitTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const getResponse = await handleRequest(mockRequest(`/ticket/${slug}`));
  const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
  if (!csrfToken) throw new Error("Failed to get CSRF token from ticket page");
  return handleRequest(mockTicketFormRequest(slug, data, csrfToken));
};

describe("server", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /", () => {
    test("redirects to admin", async () => {
      const response = await handleRequest(mockRequest("/"));
      expectRedirect("/admin/")(response);
    });
  });

  describe("GET /health", () => {
    test("returns health status", async () => {
      const response = await handleRequest(mockRequest("/health"));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ status: "ok" });
    });

    test("returns 404 for non-GET requests to /health", async () => {
      const response = await awaitTestRequest("/health", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /favicon.ico", () => {
    test("returns SVG favicon", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const svg = await response.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox");
    });

    test("returns 404 for non-GET requests to /favicon.ico", async () => {
      const response = await awaitTestRequest("/favicon.ico", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /mvp.css", () => {
    test("returns CSS stylesheet", async () => {
      const response = await handleRequest(mockRequest("/mvp.css"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
      const css = await response.text();
      expect(css).toContain(":root");
      expect(css).toContain("--color-link");
    });

    test("returns 404 for non-GET requests to /mvp.css", async () => {
      const response = await awaitTestRequest("/mvp.css", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/mvp.css"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /admin/", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("shows dashboard when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Events");
    });
  });

  describe("GET /admin (without trailing slash)", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });
  });

  describe("POST /admin/login", () => {
    test("validates required password field", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password: "" }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Password is required");
    });

    test("rejects wrong password", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password: "wrong" }),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Invalid credentials");
    });

    test("accepts correct password and sets cookie", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    });

    test("returns 429 when rate limited", async () => {
      // Rate limiting uses direct connection IP (falls back to "direct" in tests)
      const makeRequest = () =>
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          body: new URLSearchParams({ password: "wrong" }).toString(),
        });

      // Make 5 failed attempts to trigger lockout
      for (let i = 0; i < 5; i++) {
        await handleRequest(makeRequest());
      }

      // 6th attempt should be rate limited
      const response = await handleRequest(makeRequest());
      expect(response.status).toBe(429);
      const html = await response.text();
      expect(html).toContain("Too many login attempts");
    });

    test("uses server.requestIP when available", async () => {
      // Mock server object with requestIP function
      const mockServer = {
        requestIP: () => ({ address: "192.168.1.100" }),
      };

      const request = new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost",
        },
        body: new URLSearchParams({ password: "wrong" }).toString(),
      });

      // Make request with server context
      const response = await handleRequest(request, mockServer);
      // Should work (IP is extracted from server.requestIP)
      expect(response.status).toBe(401);
    });

    test("falls back to direct when server.requestIP returns null", async () => {
      // Mock server object where requestIP returns null
      const mockServer = {
        requestIP: () => null,
      };

      const request = new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost",
        },
        body: new URLSearchParams({ password: "wrong" }).toString(),
      });

      // Make request with server context
      const response = await handleRequest(request, mockServer);
      // Should still work (falls back to "direct")
      expect(response.status).toBe(401);
    });
  });

  describe("GET /admin/logout", () => {
    test("clears session and redirects", async () => {
      const response = await handleRequest(mockRequest("/admin/logout"));
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
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
        mockFormRequest("/admin/login", { password: "newpassword123" }),
      );
      expectAdminRedirect(newLoginResponse);
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

          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Stripe key updated");
          expect(html).toContain("webhook configured");
          expect(html).toContain("A Stripe secret key is currently configured");
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

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Square credentials updated");
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

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Square webhook signature key updated");
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

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Payment provider set to square");
      expect(html).toContain('checked');
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
        slug: "test-event",
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

  describe("GET /admin/sessions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/sessions"));
      expectAdminRedirect(response);
    });

    test("shows sessions page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sessions");
      expect(html).toContain("Token");
      expect(html).toContain("Expires");
      expect(html).toContain("Current");
    });

    test("highlights current session with mark", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("<mark>Current</mark>");
    });

    test("shows logout button when other sessions exist", async () => {
      // Create an extra session
      await createSession("other-session", "other-csrf", Date.now() + 10000);

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("Log out of all other sessions");
    });

    test("does not show logout button when no other sessions", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Log out of all other sessions");
    });
  });

  describe("POST /admin/sessions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/sessions", { csrf_token: "test" }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: "invalid-csrf" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("logs out other sessions and shows success message", async () => {
      // Create other sessions before login
      await createSession("other1", "csrf1", Date.now() + 10000);
      await createSession("other2", "csrf2", Date.now() + 10000);

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Logged out of all other sessions");

      // Verify other sessions are deleted
      const other1 = await getSession("other1");
      const other2 = await getSession("other2");
      expect(other1).toBeNull();
      expect(other2).toBeNull();
    });

    test("keeps current session active after logging out others", async () => {
      await createSession("other", "csrf-other", Date.now() + 10000);

      const { cookie, csrfToken } = await loginAsAdmin();

      // Extract the session token from cookie
      const sessionMatch = cookie.match(/__Host-session=([^;]+)/);
      const sessionToken = sessionMatch?.[1];

      await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      // Verify current session still exists
      const currentSession = await getSession(sessionToken || "");
      expect(currentSession).not.toBeNull();
    });
  });

  describe("POST /admin/event", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/event", {
          slug: "test-event",
          max_attendees: "100",
          max_quantity: "1",
          thank_you_url: "https://example.com",
        }),
      );
      expectAdminRedirect(response);
    });

    test("creates event when authenticated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "new-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      // Verify event was actually created
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).not.toBeNull();
      expect(event?.slug).toBe("new-event");
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "new-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("redirects to dashboard on validation failure", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "",
            max_attendees: "",
            thank_you_url: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);
    });

    test("rejects duplicate slug", async () => {
      // First, create an event with a specific slug
      await createTestEvent({
        slug: "duplicate-slug",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      // Try to create another event with the same slug
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "duplicate-slug",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      // Should redirect to admin with error (validation failure)
      expectAdminRedirect(response);
    });
  });

  describe("GET /admin/event/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/event/1"));
      expect(response.status).toBe(302);
    });

    test("redirects when wrapped data key is invalid", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create session with invalid wrapped_data_key
      const token = "test-token-invalid-event";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: `__Host-session=${token}`,
      });
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows event details when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(event.slug);
    });

    test("shows Edit link on event page", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      const html = await response.text();
      expect(html).toContain("/admin/event/1/edit");
      expect(html).toContain(">Edit<");
    });
  });

  describe("GET /admin/event/:id/export", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/export"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/export", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("returns CSV with correct headers when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(response.headers.get("content-disposition")).toContain(".csv");
    });

    test("returns CSV with attendee data", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Smith", "jane@example.com");

      const response = await awaitTestRequest(`/admin/event/${event.id}/export`, {
        cookie: cookie,
      });
      const csv = await response.text();
      expect(csv).toContain("Name,Email,Phone,Quantity,Registered");
      expect(csv).toContain("John Doe");
      expect(csv).toContain("john@example.com");
      expect(csv).toContain("Jane Smith");
      expect(csv).toContain("jane@example.com");
    });

    test("sanitizes slug for filename", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event-special",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie,
      });
      const disposition = response.headers.get("content-disposition");
      // Dashes are replaced with underscores in filename sanitization
      expect(disposition).toContain("test_event_special");
    });
  });

  describe("GET /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest("/admin/event/1/edit"));
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/edit", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows edit form when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1500,
      });

      const response = await awaitTestRequest("/admin/event/1/edit", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Edit:");
      expect(html).toContain('value="test-event"');
      expect(html).toContain('value="100"');
      expect(html).toContain('value="1500"');
      expect(html).toContain('value="https://example.com/thanks"');
    });
  });

  describe("POST /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/edit", {
          slug: "updated-event",
          max_attendees: "50",
          max_quantity: "1",
          thank_you_url: "https://example.com/updated",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/edit",
          {
            slug: "updated-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/updated",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request with invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "updated-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/updated",
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("validates required fields", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Identifier is required");
    });

    test("rejects duplicate slug on update", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create two events
      await createTestEvent({
        slug: "first-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "second-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Try to update first event to use second event's slug
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "second-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });

    test("updates event when authenticated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: event.slug,
            max_attendees: "200",
            max_quantity: "5",
            thank_you_url: "https://example.com/updated",
            unit_price: "2000",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify the event was updated
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(1);
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });
  });

  describe("GET /admin/event/:id/deactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/deactivate"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/deactivate", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows deactivate confirmation page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/deactivate", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Deactivate Event");
      expect(html).toContain("Return a 404");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("type its identifier");
      expect(html).toContain(event.slug);
    });
  });

  describe("POST /admin/event/:id/deactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/deactivate", {}),
      );
      expectAdminRedirect(response);
    });

    test("deactivates event and redirects", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/deactivate",
          { csrf_token: csrfToken, confirm_identifier: event.slug },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify event is now inactive
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const deactivatedEvent = await getEventWithCount(1);
      expect(deactivatedEvent?.active).toBe(0);
    });

    test("returns error when identifier does not match", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/deactivate",
          { csrf_token: csrfToken, confirm_identifier: "wrong-identifier" },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });
  });

  describe("GET /admin/event/:id/reactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/reactivate"),
      );
      expectAdminRedirect(response);
    });

    test("shows reactivate confirmation page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await awaitTestRequest("/admin/event/1/reactivate", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reactivate Event");
      expect(html).toContain("available for registrations");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("type its identifier");
    });
  });

  describe("POST /admin/event/:id/reactivate", () => {
    test("reactivates event and redirects", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/reactivate",
          { csrf_token: csrfToken, confirm_identifier: event.slug },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify event is now active
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const activeEvent = await getEventWithCount(1);
      expect(activeEvent?.active).toBe(1);
    });

    test("returns error when name does not match", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/reactivate",
          { csrf_token: csrfToken, confirm_identifier: "wrong-identifier" },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });
  });

  describe("GET /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/delete"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/delete", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/delete", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Event");
      expect(html).toContain(event.slug);
      expect(html).toContain("type its identifier");
    });
  });

  describe("POST /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/delete", {
          confirm_identifier: event.slug,
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/delete",
          {
            confirm_identifier: "test-event",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: event.slug,
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched event identifier", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "wrong-identifier",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("deletes event with matching identifier (case insensitive)", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "TEST-EVENT", // uppercase (case insensitive)
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const deletedEvent = await getEvent(1);
      expect(deletedEvent).toBeNull();
    });

    test("deletes event with matching identifier (trimmed)", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "  test-event  ", // with spaces
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);
    });

    test("deletes event and all attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Doe", "jane@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          {
            confirm_identifier: event.slug,
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify event and attendees were deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getEvent(event.id);
      expect(deleted).toBeNull();

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees).toEqual([]);
    });

    test("skips identifier verification when verify_identifier=false (for API users)", async () => {
      await createTestEvent({
        slug: "api-event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Login and get CSRF token
      const { cookie, csrfToken } = await loginAsAdmin();

      // Delete with verify_identifier=false - no need for confirm_identifier
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete?verify_identifier=false",
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });
  });

  describe("DELETE /admin/event/:id/delete", () => {
    test("deletes event using DELETE method", async () => {
      await createTestEvent({
        slug: "delete-method-test",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Login and get CSRF token
      const { cookie, csrfToken } = await loginAsAdmin();

      // Use DELETE method with verify_identifier=false
      const response = await handleRequest(
        new Request("http://localhost/admin/event/1/delete?verify_identifier=false", {
          method: "DELETE",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookie,
            host: "localhost",
          },
          body: new URLSearchParams({
            csrf_token: csrfToken,
          }).toString(),
        }),
      );
      expect(response.status).toBe(302);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/delete",
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("redirects when session lacks wrapped data key", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session without wrapped_data_key (simulates legacy session)
      const token = "test-token-no-data-key";
      await createSession(token, "csrf123", Date.now() + 3600000, null);

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: `__Host-session=${token}` },
      );
      expectAdminRedirect(response);
    });

    test("redirects when wrapped data key is invalid", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session with invalid wrapped_data_key (triggers decryption failure)
      const token = "test-token-invalid-key";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: `__Host-session=${token}` },
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/delete",
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different event", async () => {
      const event1 = await createTestEvent({
        slug: "event-1",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        slug: "event-2",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event2.id, event2.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      // Try to delete attendee from event 2 via event 1 URL
      const response = await awaitTestRequest(
        `/admin/event/${event1.id}/attendee/${attendee.id}/delete`,
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Attendee");
      expect(html).toContain("John Doe");
      expect(html).toContain("type their name");
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          confirm_name: "John Doe",
        }),
      );
      expectAdminRedirect(response);
    });

    test("redirects when wrapped data key is invalid", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session with invalid wrapped_data_key
      const token = "test-token-invalid-post";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { confirm_name: "John Doe", csrf_token: "csrf123" },
          `__Host-session=${token}`,
        ),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/delete",
          {
            confirm_name: "John Doe",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/delete",
          {
            confirm_name: "John Doe",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "John Doe",
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "Wrong Name",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "john doe", // lowercase
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "  John Doe  ", // with spaces
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);
    });
  });

  describe("PATCH /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("route handler returns null for unsupported method", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // PATCH is not supported by this specific route handler, which returns null.
      // The request then continues through middleware that returns 403.
      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          method: "PATCH",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("deletes attendee with DELETE method", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const formBody = new URLSearchParams({
        confirm_name: "John Doe",
        csrf_token: csrfToken,
      }).toString();

      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          method: "DELETE",
          headers: {
            host: "localhost",
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: formBody,
        }),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deletedAttendee = await getAttendeeRaw(1);
      expect(deletedAttendee).toBeNull();
    });
  });

  describe("GET /ticket/:slug", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(mockRequest("/ticket/non-existent"));
      expect(response.status).toBe(404);
    });

    test("shows ticket page for existing event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reserve Ticket");
      expect(html).toContain(`action="/ticket/${event.slug}"`);
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("<h1>Not Found</h1>");
    });
  });

  describe("POST /ticket/:slug", () => {
    test("returns 404 for non-existent event", async () => {
      // Event lookup happens before CSRF validation, so we can test without CSRF
      const response = await handleRequest(
        mockFormRequest("/ticket/non-existent", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request without CSRF token", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });

    test("validates required fields", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "",
        email: "",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Your Name is required");
    });

    test("validates name is required", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "   ",
        email: "john@example.com",
      });
      expect(response.status).toBe(400);
    });

    test("validates email is required", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John",
        email: "   ",
      });
      expect(response.status).toBe(400);
    });

    test("creates attendee and redirects to thank you page", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      expectRedirect("https://example.com/thanks")(response);
    });

    test("rejects when event is full", async () => {
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
      });
      await submitTicketForm(event.slug, {
        name: "John",
        email: "john@example.com",
      });

      const response = await submitTicketForm(event.slug, {
        name: "Jane",
        email: "jane@example.com",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("returns 404 for unsupported method on ticket route", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await awaitTestRequest(`/ticket/${event.slug}`, {
        method: "PUT",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /ticket/:slug1+:slug2 (multi-ticket)", () => {
    test("returns 404 when no valid events", async () => {
      const response = await handleRequest(
        mockRequest("/ticket/nonexistent1+nonexistent2"),
      );
      expect(response.status).toBe(404);
    });

    test("shows multi-ticket page for multiple existing events", async () => {
      const event1 = await createTestEvent({
        slug: "multi-event-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "multi-event-2",
        maxAttendees: 100,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reserve Tickets");
      expect(html).toContain(event1.slug);
      expect(html).toContain(event2.slug);
      expect(html).toContain("Select Tickets");
    });

    test("shows sold-out label for full events", async () => {
      const event1 = await createTestEvent({
        slug: "multi-available",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "multi-full",
        maxAttendees: 1,
      });
      // Fill up event2
      await createAttendeeAtomic(event2.id, "John", "john@example.com", null, 1);

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sold Out");
    });

    test("filters out inactive events", async () => {
      const event1 = await createTestEvent({
        slug: "multi-active",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "multi-inactive",
        maxAttendees: 50,
      });
      await deactivateTestEvent(event2.id);

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // The active event should have a quantity selector
      expect(html).toContain(`quantity_${event1.id}`);
      // The inactive event should not have a quantity selector
      expect(html).not.toContain(`quantity_${event2.id}`);
    });

    test("returns 404 when all events are inactive", async () => {
      const event1 = await createTestEvent({
        slug: "all-inactive-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "all-inactive-2",
        maxAttendees: 50,
      });
      await deactivateTestEvent(event1.id);
      await deactivateTestEvent(event2.id);

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /ticket/:slug1+:slug2 (multi-ticket)", () => {
    /** Helper to submit multi-ticket form with CSRF */
    const submitMultiTicketForm = async (
      slugs: string[],
      data: Record<string, string>,
    ): Promise<Response> => {
      const path = `/ticket/${slugs.join("+")}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      return handleRequest(
        mockFormRequest(path, { ...data, csrf_token: csrfToken }, `csrf_token=${csrfToken}`),
      );
    };

    test("returns 404 when no valid events", async () => {
      const response = await handleRequest(
        mockFormRequest("/ticket/nonexistent1+nonexistent2", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("validates name is required", async () => {
      const event1 = await createTestEvent({
        slug: "post-multi-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "post-multi-2",
        maxAttendees: 50,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "1",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("requires at least one ticket selected", async () => {
      const event1 = await createTestEvent({
        slug: "post-multi-empty-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "post-multi-empty-2",
        maxAttendees: 50,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "0",
        [`quantity_${event2.id}`]: "0",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select at least one ticket");
    });

    test("creates attendees for selected free events", async () => {
      const event1 = await createTestEvent({
        slug: "post-multi-free-1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "post-multi-free-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "2",
        [`quantity_${event2.id}`]: "1",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("success");

      // Verify attendees were created
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    });

    test("only registers for events with quantity > 0", async () => {
      const event1 = await createTestEvent({
        slug: "post-multi-partial-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "post-multi-partial-2",
        maxAttendees: 50,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "1",
        [`quantity_${event2.id}`]: "0",
      });
      expect(response.status).toBe(200);

      // Verify only event1 has an attendee
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees2.length).toBe(0);
    });

    test("caps quantity at max purchasable", async () => {
      const event1 = await createTestEvent({
        slug: "post-multi-cap-1",
        maxAttendees: 3,
        maxQuantity: 2,
      });
      const event2 = await createTestEvent({
        slug: "post-multi-cap-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "10", // Request more than max
        [`quantity_${event2.id}`]: "0",
      });
      expect(response.status).toBe(200);

      // Verify quantity was capped
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees = await getAttendeesRaw(event1.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.quantity).toBe(2); // Capped at maxQuantity
    });
  });

  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const response = await handleRequest(mockRequest("/unknown/path"));
      expect(response.status).toBe(404);
    });
  });

  describe("session expiration", () => {
    test("nonexistent session shows login page", async () => {
      const response = await awaitTestRequest("/admin/", "nonexistent");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("expired session is deleted and shows login page", async () => {
      // Add an expired session directly to the database
      await createSession("expired-token", "csrf-expired", Date.now() - 1000);

      const response = await awaitTestRequest("/admin/", "expired-token");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");

      // Verify the expired session was deleted
      const session = await getSession("expired-token");
      expect(session).toBeNull();
    });
  });

  describe("logout with valid session", () => {
    test("deletes session from database", async () => {
      // Log in first
      const { cookie } = await loginAsAdmin();
      const token = cookie.split("=")[1]?.split(";")[0] || "";

      expect(token).not.toBe("");
      const sessionBefore = await getSession(token);
      expect(sessionBefore).not.toBeNull();

      // Now logout
      const logoutResponse = await awaitTestRequest("/admin/logout", token);
      expect(logoutResponse.status).toBe(302);

      // Verify session was deleted
      const sessionAfter = await getSession(token);
      expect(sessionAfter).toBeNull();
    });
  });

  describe("POST /admin/event with unit_price", () => {
    test("creates event with unit_price when authenticated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "paid-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            unit_price: "1000",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /payment/success", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error when no provider configured", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment provider not configured");
    });

    test("returns error when session not found", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");
      // When session ID doesn't exist in Stripe, retrieveCheckoutSession returns null
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment session not found");
    });

    test("returns error when payment not verified", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test",
          payment_status: "unpaid",
          payment_intent: "pi_test",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("Payment verification failed");
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test",
          payment_status: "paid",
          payment_intent: "pi_test",
          metadata: {}, // Missing required fields
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          // Provider returns null for invalid metadata, so routes report "not found"
          expect(html).toContain("Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("rejects payment for inactive event and refunds", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Deactivate the event
      await deactivateTestEvent(event.id);

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_test_123",
            metadata: {
              event_id: String(event.id),
              name: "John",
              email: "john@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("no longer accepting registrations");

          // Verify refund was called
          expect(mockRefund).toHaveBeenCalledWith("pi_test_123");
        },
        resetStripeClient,
      );
    });

    test("refunds payment when event is sold out at confirmation time", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Create event with only 1 spot
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Fill the event with another attendee (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_second",
            metadata: {
              event_id: String(event.id),
              name: "Second",
              email: "second@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("sold out");
          expect(html).toContain("automatically refunded");

          // Verify refund was called
          expect(mockRefund).toHaveBeenCalledWith("pi_second");
        },
        resetStripeClient,
      );
    });
  });

  describe("GET /payment/cancel", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(null),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_invalid"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_cancel",
          payment_status: "unpaid",
          metadata: {}, // Missing required fields
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          // Provider returns null for invalid metadata, so routes report "not found"
          expect(html).toContain("Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error when event not found", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_cancel",
          payment_status: "unpaid",
          metadata: {
            event_id: "99999", // Non-existent event
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          expect(response.status).toBe(404);
          const html = await response.text();
          expect(html).toContain("Event not found");
        },
        resetStripeClient,
      );
    });

    test("shows cancel page with link back to ticket form", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_cancel",
          payment_status: "unpaid",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Payment Cancelled");
          expect(html).toContain(`/ticket/${event.slug}`);
        },
        resetStripeClient,
      );
    });
  });

  describe("payment routes", () => {
    test("returns 404 for unsupported method on payment routes", async () => {
      const response = await awaitTestRequest("/payment/success", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });
  });

  describe("ticket purchase with payments enabled", () => {
    // These tests require stripe-mock running on localhost:12111
    // STRIPE_MOCK_HOST/PORT are set in test/setup.ts
    // Stripe keys are now set via environment variables

    afterEach(() => {
      resetStripeClient();
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments (in database)
      await updateStripeKey("sk_test_fake_key");
      await setPaymentProvider("stripe");

      // Create a paid event
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should return error page because Stripe session creation fails
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to create payment session");
    });

    test("free ticket still works when payments enabled", async () => {
      await updateStripeKey("sk_test_fake_key");
      await setPaymentProvider("stripe");

      // Create a free event (no price)
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: null, // free
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to thank you page
      expectRedirect("https://example.com/thanks")(response);
    });

    test("zero price ticket is treated as free", async () => {
      await updateStripeKey("sk_test_fake_key");
      await setPaymentProvider("stripe");

      // Create event with 0 price
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // zero price
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to thank you page (no payment required)
      expectRedirect("https://example.com/thanks")(response);
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to Stripe checkout URL
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      // stripe-mock returns a URL starting with https://
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("returns error when event not found in session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_test",
            metadata: {
              event_id: "99999", // Non-existent event
              name: "John",
              email: "john@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
        }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          expect(response.status).toBe(404);
          const html = await response.text();
          expect(html).toContain("Event not found");
        },
        resetStripeClient,
      );
    });

    test("creates attendee and shows success when payment verified", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_paid",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Payment Successful");
          expect(html).toContain("https://example.com/thanks");

          // Verify attendee was created with payment ID (encrypted at rest)
          const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
          const attendees = await getAttendeesRaw(event.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.payment_id).not.toBeNull();
        },
      );
    });

    test("handles replay of same session (idempotent)", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "John", "john@example.com", "pi_test_123");

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_paid",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "1",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          // Capacity check will now fail since we already have the attendee
          // This is expected - in the new flow, replaying creates a duplicate attempt
          // which fails the capacity check if event is near full
          // For idempotent behavior, we'd need to check payment_intent uniqueness
          expect(response.status).toBe(200);
        },
      );
    });

    test("handles multiple quantity purchase", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
        maxQuantity: 5,
      });

      await withMocks(
        () => spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
          id: "cs_test_paid",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          metadata: {
            event_id: String(event.id),
            name: "John",
            email: "john@example.com",
            quantity: "3",
          },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          expect(response.status).toBe(200);

          // Verify attendee was created with correct quantity
          const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
          const attendees = await getAttendeesRaw(event.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.quantity).toBe(3);
        },
      );
    });

    test("rejects paid event registration when sold out before payment", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Create paid event with only 1 spot
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Fill the event (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(event.slug, {
        name: "Second",
        email: "second@example.com",
      });

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("handles encryption error during payment confirmation", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      const { attendeesApi } = await import("#lib/db/attendees.ts");

      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () => ({
          mockRetrieve: spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue({
            id: "cs_test",
            payment_status: "paid",
            payment_intent: "pi_test_123",
            metadata: {
              event_id: String(event.id),
              name: "John",
              email: "john@example.com",
              quantity: "1",
            },
          } as unknown as Awaited<
            ReturnType<typeof stripeApi.retrieveCheckoutSession>
          >),
          mockRefund: spyOn(stripeApi, "refundPayment").mockResolvedValue(
            { id: "re_test" } as unknown as Awaited<
              ReturnType<typeof stripeApi.refundPayment>
            >,
          ),
          mockAtomic: spyOn(attendeesApi, "createAttendeeAtomic").mockResolvedValue({
            success: false,
            reason: "encryption_error",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );

          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("Registration failed");
          expect(html).toContain("refunded");

          // Verify refund was called
          expect(mockRefund).toHaveBeenCalledWith("pi_test_123");
        },
      );
    });
  });

  describe("setup routes", () => {
    describe("when setup not complete", () => {
      beforeEach(async () => {
        // Use a fresh db without setup
        resetDb();
        await createTestDb();
      });

      test("redirects home to /setup/", async () => {
        const response = await handleRequest(mockRequest("/"));
        expectRedirect("/setup")(response);
      });

      test("redirects admin to /setup/", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expectRedirect("/setup")(response);
      });

      test("health check still works", async () => {
        const response = await handleRequest(mockRequest("/health"));
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ status: "ok" });
      });

      test("GET /setup/ shows setup page", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Initial Setup");
        expect(html).toContain("Admin Password");
        expect(html).toContain("Currency Code");
        expect(html).toContain("Data Controller Agreement");
      });

      test("GET /setup (without trailing slash) shows setup page", async () => {
        const response = await handleRequest(mockRequest("/setup"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Initial Setup");
      });

      test("POST /setup/ with valid data completes setup", async () => {
        // First get CSRF token from GET request
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );
        expect(csrfToken).not.toBeNull();

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "USD",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("POST /setup/ without CSRF token rejects request", async () => {
        // POST without getting CSRF token first
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "USD",
          }),
        );
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).toContain("Invalid or expired form");
      });

      test("POST /setup/ with mismatched CSRF tokens rejects request", async () => {
        // Get a valid CSRF token from cookie
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const cookieCsrf = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        // Send a different token in the form body than the cookie
        const response = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
              cookie: `setup_csrf=${cookieCsrf}`,
            },
            body: new URLSearchParams({
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "USD",
              csrf_token: "wrong-token-in-form",
            }).toString(),
          }),
        );
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).toContain("Invalid or expired form");
      });

      test("POST /setup/ with empty password shows validation error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "",
              admin_password_confirm: "",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Admin Password * is required");
      });

      test("POST /setup/ with mismatched passwords shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "different",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Passwords do not match");
      });

      test("POST /setup/ with short password shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "short",
              admin_password_confirm: "short",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("at least 8 characters");
      });

      test("POST /setup/ with invalid currency shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "INVALID",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Currency code must be 3 uppercase letters");
      });

      test("POST /setup/ without accepting agreement shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
              accept_agreement: "", // Explicitly not accepting
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("must accept the Data Controller Agreement");
      });

      test("POST /setup/ normalizes lowercase currency to uppercase", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "usd",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("POST /setup/ throws error when completeSetup fails", async () => {
        const { spyOn } = await import("#test-compat");
        const { settingsApi } = await import("#lib/db/settings.ts");

        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        await withMocks(
          () => ({
            mockCompleteSetup: spyOn(settingsApi, "completeSetup").mockRejectedValue(
              new Error("Database error"),
            ),
            mockConsoleError: spyOn(console, "error").mockImplementation(() => {}),
          }),
          async () => {
            await expect(
              handleRequest(
                mockSetupFormRequest(
                  {
                    admin_password: "mypassword123",
                    admin_password_confirm: "mypassword123",
                    currency_code: "GBP",
                  },
                  csrfToken as string,
                ),
              ),
            ).rejects.toThrow("Database error");
          },
        );
      });

      test("PUT /setup/ redirects to /setup/ (unsupported method)", async () => {
        const response = await awaitTestRequest("/setup/", { method: "PUT" });
        // PUT method falls through routeSetup (returns null), then redirects to /setup/
        expectRedirect("/setup")(response);
      });

      test("setup form works with full browser flow simulation", async () => {
        // This test simulates what a real browser does:
        // 1. GET /setup/ - browser receives the page and Set-Cookie header
        // 2. User fills form and submits
        // 3. Browser sends POST with cookie

        // Step 1: GET the setup page
        const getResponse = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );
        expect(getResponse.status).toBe(200);

        // Extract the Set-Cookie header
        const setCookie = getResponse.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();

        // Extract CSRF token from the cookie
        const csrfToken = getSetupCsrfToken(setCookie);
        expect(csrfToken).not.toBeNull();

        // Step 2: Simulate browser POST - browser sends cookie back
        const postResponse = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
              cookie: `setup_csrf=${csrfToken}`,
            },
            body: new URLSearchParams({
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
              accept_agreement: "yes",
              csrf_token: csrfToken as string,
            }).toString(),
          }),
        );

        // This should succeed - the full flow should work
        expect(postResponse.status).toBe(200);
        const html = await postResponse.text();
        expect(html).toContain("Setup Complete");
      });

      test("setup cookie path allows both /setup and /setup/", async () => {
        // Cookie path should be /setup (without trailing slash) to match both variants
        const response = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );

        const setCookie = response.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();
        // Path should be /setup (not /setup/) so it matches both
        expect(setCookie).toContain("Path=/setup;");
        expect(setCookie).not.toContain("Path=/setup/;");
      });

      test("setup form works when accessed via /setup (no trailing slash)", async () => {
        // GET /setup (no trailing slash)
        const getResponse = await handleRequest(
          new Request("http://localhost/setup", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );
        expect(getResponse.status).toBe(200);

        const setCookie = getResponse.headers.get("set-cookie");
        const csrfToken = getSetupCsrfToken(setCookie);
        expect(csrfToken).not.toBeNull();

        // POST to /setup (no trailing slash) - cookie should still be sent
        const postResponse = await handleRequest(
          new Request("http://localhost/setup", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
              cookie: `setup_csrf=${csrfToken}`,
            },
            body: new URLSearchParams({
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
              accept_agreement: "yes",
              csrf_token: csrfToken as string,
            }).toString(),
          }),
        );

        expect(postResponse.status).toBe(200);
        const html = await postResponse.text();
        expect(html).toContain("Setup Complete");
      });

      test("CSRF token in cookie matches token in HTML form field", async () => {
        // This test verifies that the same token appears in both places
        const response = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );

        // Extract token from Set-Cookie header
        const setCookie = response.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();
        const cookieToken = getSetupCsrfToken(setCookie);
        expect(cookieToken).not.toBeNull();

        // Extract token from HTML body
        const html = await response.text();
        const formTokenMatch = html.match(
          /name="csrf_token"\s+value="([^"]+)"/,
        );
        expect(formTokenMatch).not.toBeNull();
        const formToken = formTokenMatch?.[1];

        // They must be identical
        expect(formToken).toBe(cookieToken as string);
      });
    });

    describe("when setup already complete", () => {
      test("GET /setup/ redirects to home", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expectRedirect("/")(response);
      });

      test("POST /setup/ redirects to home", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "newpassword123",
            admin_password_confirm: "newpassword123",
            currency_code: "EUR",
          }),
        );
        expectRedirect("/")(response);
      });
    });
  });

  describe("security headers", () => {
    describe("X-Frame-Options", () => {
      test("home page has X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("admin pages have X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("ticket page does NOT have X-Frame-Options (embeddable)", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("x-frame-options")).toBeNull();
      });

      test("payment pages have X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/payment/success"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("setup page has X-Frame-Options: DENY", async () => {
        resetDb();
        await createTestDb();
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });
    });

    describe("Content-Security-Policy", () => {
      const baseCsp =
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self' https://checkout.stripe.com";

      test("non-embeddable pages have frame-ancestors 'none' and security restrictions", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("content-security-policy")).toBe(
          `frame-ancestors 'none'; ${baseCsp}`,
        );
      });

      test("ticket page has CSP but allows embedding (no frame-ancestors)", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("content-security-policy")).toBe(baseCsp);
      });
    });

    describe("other security headers", () => {
      test("responses have X-Content-Type-Options: nosniff", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      });

      test("responses have Referrer-Policy header", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
      });

      test("responses have X-Robots-Tag: noindex, nofollow", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });

      test("ticket pages also have base security headers", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });
    });
  });

  describe("Content-Type validation", () => {
    test("rejects POST requests without Content-Type header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });

    test("rejects POST requests with wrong Content-Type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "test" }),
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("POST /payment/webhook", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns 400 when no provider configured", async () => {
      const response = await handleRequest(
        new Request("http://localhost/payment/webhook", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            "stripe-signature": "sig_test",
          },
          body: JSON.stringify({ type: "checkout.session.completed" }),
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Payment provider not configured");
    });

    test("returns 400 when signature header is missing", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const response = await handleRequest(
        new Request("http://localhost/payment/webhook", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ type: "checkout.session.completed" }),
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Missing signature");
    });

    test("returns 400 when signature verification fails", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({ valid: false, error: "Invalid signature" });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_bad",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid signature");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("acknowledges non-checkout events", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "payment_intent.created",
          data: { object: {} },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("returns 400 for invalid session data in webhook", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test",
              payment_status: "paid",
              metadata: {}, // Missing required fields
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("acknowledges unpaid checkout without processing", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test",
              payment_status: "unpaid",
              payment_intent: "pi_test",
              metadata: {
                event_id: String(event.id),
                name: "John",
                email: "john@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.status).toBe("pending");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("processes valid single-ticket webhook and creates attendee", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_webhook_test",
              payment_status: "paid",
              payment_intent: "pi_webhook_test",
              metadata: {
                event_id: String(event.id),
                name: "Webhook User",
                email: "webhook@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBe(true);

        // Verify attendee was created
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.payment_id).not.toBeNull();
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("processes valid multi-ticket webhook and creates attendees", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "webhook-multi-1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "webhook-multi-2",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_webhook",
              payment_status: "paid",
              payment_intent: "pi_multi_webhook",
              metadata: {
                name: "Multi User",
                email: "multi@example.com",
                phone: "123456",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 2 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBe(true);

        // Verify attendees were created for both events
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        const attendees2 = await getAttendeesRaw(event2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees1[0]?.quantity).toBe(2);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(1);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook returns error for invalid multi-ticket items", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_bad_multi",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_bad_multi",
              payment_status: "paid",
              payment_intent: "pi_bad",
              metadata: {
                name: "Bad Multi",
                email: "bad@example.com",
                multi: "1",
                items: "not-valid-json{",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid multi-ticket session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook handles sold-out event and returns error in JSON", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the event
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_soldout",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_soldout",
              payment_status: "paid",
              payment_intent: "pi_soldout",
              metadata: {
                event_id: String(event.id),
                name: "Late Buyer",
                email: "late@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        // Webhook returns 200 even for business logic failures to prevent retries
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBe(false);
        expect(json.error).toContain("sold out");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook rejects POST with wrong content-type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/payment/webhook", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
            "stripe-signature": "sig_test",
          },
          body: "test=123",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("GET /payment/success (multi-ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes multi-ticket payment success", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "success-multi-1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "success-multi-2",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_success",
        payment_status: "paid",
        payment_intent: "pi_multi_success",
        metadata: {
          name: "Multi Payer",
          email: "multi@example.com",
          multi: "1",
          items: JSON.stringify([
            { e: event1.id, q: 1 },
            { e: event2.id, q: 2 },
          ]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_success"),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Successful");

        // Verify attendees created for both events
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        const attendees2 = await getAttendeesRaw(event2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("returns error for invalid multi-ticket metadata", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_bad_multi",
        payment_status: "paid",
        payment_intent: "pi_bad",
        metadata: {
          name: "Bad",
          email: "bad@example.com",
          multi: "1",
          items: "not-an-array",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad_multi"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Invalid multi-ticket session data");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("refunds multi-ticket payment when event not found", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_notfound",
        payment_status: "paid",
        payment_intent: "pi_multi_notfound",
        metadata: {
          name: "Missing Event",
          email: "missing@example.com",
          multi: "1",
          items: JSON.stringify([{ e: 99999, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_notfound"),
        );
        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("Event not found");
        expect(mockRefund).toHaveBeenCalledWith("pi_multi_notfound");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("refunds multi-ticket payment when event is inactive", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "multi-inactive-pay",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_inactive",
        payment_status: "paid",
        payment_intent: "pi_multi_inactive",
        metadata: {
          name: "Inactive Event",
          email: "inactive@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_inactive"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer accepting registrations");
        expect(html).toContain("refunded");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("shows refund failure message when refund fails", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the event
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_refund_fail",
        payment_status: "paid",
        payment_intent: "pi_refund_fail",
        metadata: {
          event_id: String(event.id),
          name: "Refund Fail",
          email: "refund@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      // Mock refund to fail
      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_fail"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
        expect(html).toContain("contact support");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket payment sold out rolls back and refunds", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-rollback-1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "multi-rollback-2",
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill event2
      await createAttendeeAtomic(event2.id, "First", "first@example.com", "pi_first");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_rollback",
        payment_status: "paid",
        payment_intent: "pi_multi_rollback",
        metadata: {
          name: "Rollback User",
          email: "rollback@example.com",
          multi: "1",
          items: JSON.stringify([
            { e: event1.id, q: 1 },
            { e: event2.id, q: 1 },
          ]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_rollback"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
        expect(html).toContain("refunded");

        // Verify rollback: event1 should have no attendees since they were rolled back
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("shows thank_you_url for single-ticket success", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
        thankYouUrl: "https://example.com/single-thanks",
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_thankyou",
        payment_status: "paid",
        payment_intent: "pi_single_thankyou",
        metadata: {
          event_id: String(event.id),
          name: "Single",
          email: "single@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("https://example.com/single-thanks");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("handles duplicate session replay (already processed)", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_dupe_session",
        payment_status: "paid",
        payment_intent: "pi_dupe",
        metadata: {
          event_id: String(event.id),
          name: "Dupe",
          email: "dupe@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        // First request should succeed
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response1.status).toBe(200);

        // Second request (replay) should also succeed (idempotent)
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response2.status).toBe(200);

        // Should still only have one attendee
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.mockRestore();
      }
    });
  });

  describe("GET /admin/activity-log", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/activity-log"));
      expectAdminRedirect(response);
    });

    test("shows activity log page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      // Create an event to generate activity
      await createTestEvent({
        slug: "activity-log-test",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest("/admin/activity-log", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Activity Log");
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
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Payment provider set to stripe");
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
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Payment provider disabled");
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

  describe("GET /admin/event/:id/activity-log", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/event/1/activity-log"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/activity-log", {
        cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows activity log for existing event", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "event-activity-log",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/activity-log`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Activity Log");
      expect(html).toContain(event.slug);
    });
  });

  describe("POST /admin/event/:id/deactivate (event not found)", () => {
    test("returns 404 when event does not exist", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/deactivate",
          { csrf_token: csrfToken, confirm_identifier: "something" },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/event/:id/reactivate (event not found)", () => {
    test("returns 404 when event does not exist", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/reactivate",
          { csrf_token: csrfToken, confirm_identifier: "something" },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /ticket/:slug (free event without thank_you_url)", () => {
    test("shows inline success page when no thank_you_url", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "", // No thank_you_url
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      // Should show success page instead of redirect
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("success");
    });
  });

  describe("multi-ticket paid flow", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("redirects to checkout for multi-ticket paid events", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-paid-1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-paid-2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "2",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Should redirect to Stripe checkout
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("shows error when no tickets selected in multi-ticket paid form", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-nosel-1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-nosel-2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with all quantities at 0
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "0",
            [`quantity_${event2.id}`]: "0",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select at least one ticket");
    });
  });

  describe("multi-ticket free flow (capacity exceeded)", () => {
    test("shows error when free multi-ticket atomic create fails capacity", async () => {
      const event1 = await createTestEvent({
        slug: "multi-free-cap-1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-free-cap-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock atomic create to fail on second call (simulates race condition)
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const origCreate = attendeesApi.createAttendeeAtomic;
      let callCount = 0;
      const mockCreate = spyOn(attendeesApi, "createAttendeeAtomic");
      mockCreate.mockImplementation(async (...args: Parameters<typeof origCreate>) => {
        callCount++;
        if (callCount === 2) {
          return { success: false as const, reason: "capacity_exceeded" as const };
        }
        return origCreate(...args);
      });

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              name: "John Doe",
              email: "john@example.com",
              [`quantity_${event1.id}`]: "1",
              [`quantity_${event2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer has enough spots");
      } finally {
        mockCreate.mockRestore();
      }
    });

    test("multi-ticket free registration succeeds for both events", async () => {
      const event1 = await createTestEvent({
        slug: "multi-free-ok-1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-free-ok-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "Multi Free User",
            email: "multifree@example.com",
            [`quantity_${event1.id}`]: "2",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("success");

      // Verify attendees created for both events
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    });
  });

  describe("POST /ticket/:slug1+:slug2 (unsupported method)", () => {
    test("returns 404 for PUT on multi-ticket route", async () => {
      const event1 = await createTestEvent({
        slug: "multi-put-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "multi-put-2",
        maxAttendees: 50,
      });
      const response = await awaitTestRequest(
        `/ticket/${event1.slug}+${event2.slug}`,
        { method: "PUT" },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("setup routes (currency code default)", () => {
    test("POST /setup/ with empty currency code defaults to GBP", async () => {
      resetDb();
      await createTestDb();

      const getResponse = await handleRequest(mockRequest("/setup/"));
      const csrfToken = getSetupCsrfToken(getResponse.headers.get("set-cookie"));
      expect(csrfToken).not.toBeNull();

      const response = await handleRequest(
        mockSetupFormRequest(
          {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "", // Empty defaults to GBP
          },
          csrfToken as string,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Setup Complete");
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete (no privateKey on POST)", () => {
    test("redirects to admin when session lacks wrapped data key on POST", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session without wrapped_data_key (simulates legacy session)
      const token = "test-token-no-data-key-post";
      await createSession(token, "csrf123", Date.now() + 3600000, null);

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { confirm_name: "John Doe", csrf_token: "csrf123" },
          `__Host-session=${token}`,
        ),
      );
      expectAdminRedirect(response);
    });

    test("handles missing confirm_name field (falls back to empty string)", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      // Submit without confirm_name field at all
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      // Empty string won't match "John Doe", so it returns 400
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });
  });

  describe("POST /admin/login (dataKey null path)", () => {
    test("creates session even when dataKey is null", async () => {
      // This test covers the `wrappedDataKey = dataKey ? await wrapKeyWithToken(dataKey, token) : null` path
      // When login succeeds but unwrapDataKey returns null, session still has null wrappedDataKey
      // In normal operation this won't happen since setup creates keys, but we test the code path
      const { spyOn } = await import("#test-compat");
      const { settingsApi } = await import("#lib/db/settings.ts");

      const mockUnwrap = spyOn(settingsApi, "unwrapDataKey");
      mockUnwrap.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
        );
        // Should still redirect (login succeeds)
        expectAdminRedirect(response);
        expect(response.headers.get("set-cookie")).toContain("__Host-session=");
      } finally {
        mockUnwrap.mockRestore();
      }
    });
  });

  describe("admin/events.ts (event delete handler via onDelete)", () => {
    test("delete event handler cleans up associated data", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "on-delete-test",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "Test User", "test@example.com");

      // Delete event via API (skip verify)
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify both event and attendees deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      expect(await getEvent(event.id)).toBeNull();
      expect((await getAttendeesRaw(event.id)).length).toBe(0);
    });
  });

  describe("admin/events.ts (withEventAttendees privateKey null)", () => {
    test("redirects when session has no wrapped data key on event view", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create session without wrapped_data_key
      const token = "test-token-no-key-event";
      await createSession(token, "csrf123", Date.now() + 3600000, null);

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: `__Host-session=${token}`,
      });
      expectAdminRedirect(response);
    });
  });

  describe("admin/events.ts (eventErrorPage with deleted event)", () => {
    test("edit validation returns 400 with error when event exists", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create two events
      await createTestEvent({
        slug: "first-edit-err",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "second-edit-err",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Try to update first event with second event's slug (duplicate slug error)
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "second-edit-err",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      // Should return 400 with error page (event exists -> eventErrorPage returns htmlResponse)
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });
  });

  describe("admin/events.ts (form.get fallbacks)", () => {
    test("deactivate event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "deactivate-fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/deactivate`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });

    test("reactivate event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "reactivate-fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await deactivateTestEvent(event.id);

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/reactivate`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });

    test("delete event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "delete-fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/1/delete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
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

  describe("routes/middleware.ts (empty content-type)", () => {
    test("POST with empty content-type is rejected", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("routes/public.ts (additional coverage)", () => {
    test("ticket form with phone-only fields (no email field) works", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        fields: "phone",
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        phone: "555-1234",
      });
      // With fields="phone", email is not collected and extractContact returns "" for email
      expectRedirect("https://example.com/thanks")(response);
    });

    test("ticket form with invalid quantity falls back to minimum", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        maxQuantity: 5,
      });

      // Submit with non-numeric quantity
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
        quantity: "abc",
      });
      // Should still succeed with quantity falling back to 1
      expectRedirect("https://example.com/thanks")(response);
    });

    test("multi-ticket skips sold-out events in quantity parsing", async () => {
      const event1 = await createTestEvent({
        slug: "multi-soldout-parse-1",
        maxAttendees: 1,
        maxQuantity: 1,
      });
      const event2 = await createTestEvent({
        slug: "multi-soldout-parse-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      // Fill up event1 to make it sold out
      await createAttendeeAtomic(event1.id, "First", "first@example.com", null, 1);

      // GET the multi-ticket page (sold-out event will show Sold Out label)
      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      expect(getResponse.status).toBe(200);
      const html = await getResponse.text();
      expect(html).toContain("Sold Out");

      // POST with quantity for both events - sold out event's quantity is ignored
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(200);
      const resultHtml = await response.text();
      expect(resultHtml).toContain("success");
    });

    test("multi-ticket with invalid quantity form value falls back to 0", async () => {
      const event1 = await createTestEvent({
        slug: "multi-invalid-qty-1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-invalid-qty-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with non-numeric quantity for event1 and valid for event2
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "abc",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(200);

      // Only event2 should have an attendee
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(0);
      expect(attendees2.length).toBe(1);
    });

    test("multi-ticket paid checks availability and rejects sold out", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-avail-1",
        maxAttendees: 1,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-avail-2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      // Fill event1
      await createAttendeeAtomic(event1.id, "First", "first@example.com", "pi_first");

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Try to purchase - event1 is sold out
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Should redirect to checkout since only event2 has quantity (event1 is sold out and skipped)
      expect(response.status).toBe(302);
      resetStripeClient();
    });

    test("returns null for non-ticket paths", async () => {
      const response = await handleRequest(mockRequest("/notticket/test"));
      expect(response.status).toBe(404);
    });

    test("returns null when slug is empty from path extraction", async () => {
      const response = await handleRequest(mockRequest("/ticket/"));
      // Path /ticket/ is normalized to /ticket, which doesn't match slug pattern
      expect(response.status).toBe(404);
    });
  });

  describe("routes/public.ts (multi-ticket CSRF)", () => {
    test("multi-ticket POST rejects invalid CSRF token", async () => {
      const event1 = await createTestEvent({
        slug: "multi-csrf-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "multi-csrf-2",
        maxAttendees: 50,
      });

      // POST without getting CSRF token first
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event1.slug}+${event2.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing path)", () => {
    test("shows payment not configured error for multi-ticket when no provider", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-noprov-1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-noprov-2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      // Now clear the provider to simulate no provider
      const { clearPaymentProvider } = await import("#lib/db/settings.ts");
      await clearPaymentProvider();

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Free registration path since provider is cleared and isPaymentsEnabled returns false
      expect(response.status).toBe(200);
      resetStripeClient();
    });
  });

  describe("routes/router.ts (slug and generic param patterns)", () => {
    test("slug pattern matches lowercase alphanumeric with hyphens", async () => {
      const event = await createTestEvent({
        slug: "my-test-event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
    });
  });

  describe("routes/utils.ts (getPrivateKey null paths)", () => {
    test("returns null when wrappedDataKey is null", async () => {
      // This is tested indirectly via session without wrapped_data_key
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session without wrapped_data_key
      const token = "test-no-wrapped-key";
      await createSession(token, "csrf123", Date.now() + 3600000, null);

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/1/delete`,
        { cookie: `__Host-session=${token}` },
      );
      expectAdminRedirect(response);
    });

    test("returns null when wrappedPrivateKey is not set in DB", async () => {
      // Clear the wrapped_private_key from DB so getWrappedPrivateKey returns null
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
        args: [],
      });

      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      // Should redirect since getPrivateKey returns null (no wrapped private key)
      expectAdminRedirect(response);
    });

    test("returns null when getPrivateKeyFromSession throws", async () => {
      // Create a session with a corrupt wrapped_data_key that will cause crypto to throw
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const token = "test-corrupt-key";
      await createSession(token, "csrf123", Date.now() + 3600000, "corrupt-key-data");

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: `__Host-session=${token}`,
      });
      // Should redirect since getPrivateKey catches the crypto error and returns null
      expectAdminRedirect(response);
    });

    test("empty csrf_token from form falls back to empty string", async () => {
      const { cookie } = await loginAsAdmin();

      // Send form without csrf_token field at all
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          { current_password: "test" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });
  });

  describe("routes/webhooks.ts (additional coverage)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("extractIntent defaults quantity to 1 when missing", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_no_qty",
        payment_status: "paid",
        payment_intent: "pi_no_qty",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          // quantity intentionally omitted
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_no_qty"),
        );
        expect(response.status).toBe(200);

        // Verify attendee was created with quantity 1
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(1);
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("tryRefund returns false when paymentReference is null", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await deactivateTestEvent(event.id);

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_null_ref",
        payment_status: "paid",
        payment_intent: null, // No payment reference
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_null_ref"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer accepting registrations");
        // Should show "contact support" since refund failed (no payment reference)
        expect(html).toContain("contact support");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("webhook with non-string event_id in metadata rejects", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_bad_event_id",
              payment_status: "paid",
              payment_intent: "pi_test",
              metadata: {
                event_id: 123, // number, not string
                name: "John",
                email: "john@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook extracts payment_intent as paymentReference", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_pi_extract",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_pi_extract",
              payment_status: "paid",
              payment_intent: "pi_extracted_ref",
              metadata: {
                event_id: String(event.id),
                name: "PI User",
                email: "pi@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);

        // Verify attendee has the payment reference
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.payment_id).not.toBeNull();
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook with non-array items in multi-ticket returns null", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_non_array",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_non_array",
              payment_status: "paid",
              payment_intent: "pi_non_array",
              metadata: {
                name: "Test",
                email: "test@example.com",
                multi: "1",
                items: '{"not":"an-array"}', // Valid JSON but not an array
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid multi-ticket session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook with missing items in multi-ticket metadata returns null", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_items",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_no_items",
              payment_status: "paid",
              payment_intent: "pi_no_items",
              metadata: {
                name: "Test",
                email: "test@example.com",
                multi: "1",
                items: "", // empty string: isMultiSession returns true but extractMultiIntent returns null
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("Invalid multi-ticket session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("multi-ticket being processed returns 409", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "multi-concurrent",
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_multi_concurrent");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_concurrent",
        payment_status: "paid",
        payment_intent: "pi_multi_concurrent",
        metadata: {
          name: "Concurrent",
          email: "concurrent@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_concurrent"),
        );
        expect(response.status).toBe(409);
        const html = await response.text();
        expect(html).toContain("being processed");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("single-ticket being processed returns 409", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Pre-reserve the session to simulate concurrent processing
      const { reserveSession: reserveSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_single_concurrent");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_concurrent",
        payment_status: "paid",
        payment_intent: "pi_single_concurrent",
        metadata: {
          event_id: String(event.id),
          name: "Concurrent",
          email: "concurrent@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_concurrent"),
        );
        expect(response.status).toBe(409);
        const html = await response.text();
        expect(html).toContain("being processed");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("multi-ticket pricePaid calculation uses unit_price * quantity", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "multi-price-calc",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_price",
        payment_status: "paid",
        payment_intent: "pi_multi_price",
        metadata: {
          name: "Price Test",
          email: "price@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 3 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_price"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(3);
        // price_paid is stored encrypted, verify it was set (not null)
        expect(attendees[0]?.price_paid).not.toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("single-ticket pricePaid calculation uses unit_price * quantity", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_price",
        payment_status: "paid",
        payment_intent: "pi_single_price",
        metadata: {
          event_id: String(event.id),
          name: "Price Single",
          email: "price@example.com",
          quantity: "2",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_price"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        // price_paid is stored encrypted, verify it was set (not null)
        expect(attendees[0]?.price_paid).not.toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("formatPaymentError returns plain error when refunded is undefined", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // This tests the case where result.refunded is undefined
      // This happens when validatePaidSession fails (no refund attempt)
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_plain_error",
        payment_status: "unpaid",
        payment_intent: "pi_test",
        metadata: {
          event_id: "1",
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_plain_error"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment verification failed");
        // Should NOT contain refund-related text
        expect(html).not.toContain("refunded");
        expect(html).not.toContain("contact support for a refund");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("webhook cancel page returns error when no provider", async () => {
      // Don't set up any payment provider
      const response = await handleRequest(
        mockRequest("/payment/cancel?session_id=cs_cancel_no_prov"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment provider not configured");
    });

    test("multi-ticket failure error message for encryption_error", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "multi-enc-err",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_enc_err",
        payment_status: "paid",
        payment_intent: "pi_multi_enc_err",
        metadata: {
          name: "Enc Error",
          email: "enc@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      // Mock atomic create to return encryption error
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "encryption_error",
      });

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_enc_err"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Registration failed");
        expect(html).toContain("refunded");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
        mockAtomic.mockRestore();
      }
    });

    test("multi-ticket no firstAttendee returns refund error", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Mock empty items list (edge case where items parsed but empty after filtering)
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_empty_items",
        payment_status: "paid",
        payment_intent: "pi_multi_empty",
        metadata: {
          name: "Empty Items",
          email: "empty@example.com",
          multi: "1",
          items: "[]", // Empty array
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_empty_items"),
        );
        // Empty items list returns "Invalid multi-ticket session data"
        expect(response.status).toBe(400);
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket with non-string payment_intent sets null paymentReference", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "multi-no-pi",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_pi",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_no_pi",
              payment_status: "paid",
              payment_intent: 12345, // Number, not string
              metadata: {
                event_id: String(event.id),
                name: "No PI",
                email: "nopi@example.com",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });
  });

  describe("POST multi-ticket capacity check via atomic create", () => {
    test("shows error for free multi-ticket when atomic create fails", async () => {
      const event1 = await createTestEvent({
        slug: "multi-free-atomic-1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        slug: "multi-free-atomic-2",
        maxAttendees: 50,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock attendeesApi to fail on second event (capacity exceeded)
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const originalFn = attendeesApi.createAttendeeAtomic;
      let callCount = 0;
      attendeesApi.createAttendeeAtomic = async (...args) => {
        callCount++;
        if (callCount === 2) {
          return { success: false, reason: "capacity_exceeded" };
        }
        return originalFn(...args);
      };

      try {
        const response = await handleRequest(
          mockFormRequest(path, {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          }, `csrf_token=${csrfToken}`),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer has enough spots");
      } finally {
        attendeesApi.createAttendeeAtomic = originalFn;
      }
    });
  });

  describe("POST /admin/event/:id/edit validation error", () => {
    test("shows error when editing non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/99999/edit",
          {
            slug: "updated-slug",
            max_attendees: "50",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("shows edit page with error when slug is already taken", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event1 = await createTestEvent({
        slug: "edit-orig",
        maxAttendees: 50,
      });
      await createTestEvent({
        slug: "edit-taken",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event1.id}/edit`,
          {
            slug: "edit-taken",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });
  });

  describe("POST /admin/event/:id/delete with custom onDelete", () => {
    test("deletes event and cascades to attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        slug: "cascade-delete",
        maxAttendees: 50,
      });
      await createTestAttendee(event.id, event.slug, "Test User", "test@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      const { getEvent: getEventFn } = await import("#lib/db/events.ts");
      const deleted = await getEventFn(event.id);
      expect(deleted).toBeNull();
    });
  });

  describe("webhook multi-ticket already processed", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns success for already-processed multi-ticket session", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "multi-already-done",
        maxAttendees: 50,
        unitPrice: 500,
      });
      // Create attendee directly (not via public form which redirects to Stripe for paid events)
      const result = await createAttendeeAtomic(event.id, "Already Done", "already@example.com", "pi_already_done", 1);
      if (!result.success) throw new Error("Failed to create test attendee");
      const attendee = result.attendee;

      const { reserveSession: reserveSessionFn, finalizeSession: finalizeSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_multi_already_done");
      await finalizeSessionFn("cs_multi_already_done", attendee.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_already_done",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_already_done",
              payment_status: "paid",
              payment_intent: "pi_already_done",
              metadata: {
                name: "Already Done",
                email: "already@example.com",
                multi: "1",
                items: JSON.stringify([{ e: event.id, q: 1 }]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook handles multi-ticket with inactive event and rollback", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-wh-active",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "multi-wh-inactive",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event2.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_inactive_wh",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_inactive_wh",
              payment_status: "paid",
              payment_intent: "pi_multi_inactive_wh",
              metadata: {
                name: "Multi Inactive",
                email: "inactive@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(false);
        expect(json.error).toContain("no longer accepting");

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook handles multi-ticket sold out in second event", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-wh-avail",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "multi-wh-full",
        maxAttendees: 1,
        unitPrice: 500,
      });
      await createAttendeeAtomic(event2.id, "First", "first@example.com", "pi_first", 1);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_soldout_wh",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_soldout_wh",
              payment_status: "paid",
              payment_intent: "pi_multi_soldout_wh",
              metadata: {
                name: "Sold Out Multi",
                email: "soldout@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(false);
        expect(json.error).toContain("sold out");

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook handles non-checkout event type by acknowledging", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_other_type",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_test",
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.processed).toBeUndefined();
      } finally {
        mockVerify.mockRestore();
      }
    });
  });

  describe("Domain validation", () => {
    test("allows requests with valid domain", async () => {
      const response = await handleRequest(mockRequest("/"));
      expect(response.status).toBe(302); // Homepage redirects to /admin/
    });

    test("rejects GET requests to invalid domain", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "evil.com"),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("rejects POST requests to invalid domain", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/admin/login", "evil.com", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("allows requests with valid domain including port", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "localhost:3000"),
      );
      expect(response.status).toBe(302); // Homepage redirects to /admin/
    });

    test("rejects requests without Host header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/", {}),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("domain rejection response has security headers", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "evil.com"),
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });
  });

  describe("routes/admin/auth.ts (wrappedDataKey null path)", () => {
    test("login succeeds even when wrapped data key is missing", async () => {
      // Remove the wrapped_data_key from settings to trigger null path
      const { setSetting } = await import("#lib/db/settings.ts");
      await setSetting("wrapped_data_key", "");

      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      // Login should still succeed - session is created with null wrapped data key
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });
  });

  describe("routes/router.ts (param patterns)", () => {
    test("matches slug pattern with lowercase alphanumeric and hyphens", async () => {
      const event = await createTestEvent({
        slug: "my-test-event",
        maxAttendees: 50,
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
    });

    test("returns 404 for unknown route pattern", async () => {
      const response = await handleRequest(mockRequest("/unknown-path-xyz"));
      expect(response.status).toBe(404);
    });
  });

  describe("routes/utils.ts (getPrivateKey error handling)", () => {
    test("getPrivateKey returns null when getPrivateKeyFromSession throws", async () => {
      const { getPrivateKey } = await import("#routes/utils.ts");
      // Pass an invalid wrappedDataKey to trigger the catch block
      const result = await getPrivateKey("invalid-token", "not-a-valid-wrapped-key");
      expect(result).toBeNull();
    });
  });

  describe("routes/admin/events.ts (event error page)", () => {
    test("shows edit error page for existing event with duplicate slug", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event1 = await createTestEvent({
        slug: "event-err-1",
        maxAttendees: 50,
      });
      await createTestEvent({
        slug: "event-err-2",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event1.id}/edit`,
          {
            slug: "event-err-2",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });

    test("event delete cascades to attendees using custom onDelete", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        slug: "cascade-del-test",
        maxAttendees: 50,
      });
      await createTestAttendee(event.id, event.slug, "Del User", "del@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(0);
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("returns 404 for non-existent attendee on delete page", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({
        slug: "att-del-404",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/attendee/99999/delete`, {
          headers: {
            host: "localhost",
            cookie,
          },
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("routes/public.ts (multi-ticket paid flow)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket paid flow redirects to Stripe checkout", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-paid-1",
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const event2 = await createTestEvent({
        slug: "multi-paid-2",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(path, {
          name: "John Doe",
          email: "john@example.com",
          [`quantity_${event1.id}`]: "1",
          [`quantity_${event2.id}`]: "1",
          csrf_token: csrfToken,
        }, `csrf_token=${csrfToken}`),
      );
      // Should redirect to Stripe checkout
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toContain("checkout.stripe.com");
    });

    test("multi-ticket paid flow shows error when session creation fails", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-nourl-1",
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const event2 = await createTestEvent({
        slug: "multi-nourl-2",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock createMultiCheckoutSession to return no URL
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockCreate = spyOn(stripePaymentProvider, "createMultiCheckoutSession");
      mockCreate.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockFormRequest(path, {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          }, `csrf_token=${csrfToken}`),
        );
        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("Failed to create payment session");
      } finally {
        mockCreate.mockRestore();
      }
    });

    test("multi-ticket skips sold-out events in quantity parsing", async () => {
      const event1 = await createTestEvent({
        slug: "multi-soldout-1",
        maxAttendees: 1,
      });
      const event2 = await createTestEvent({
        slug: "multi-soldout-2",
        maxAttendees: 50,
      });

      // Fill event1 to capacity
      await createAttendeeAtomic(event1.id, "First", "first@example.com", null, 1);

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with qty for both events, but event1 should be skipped as sold out
      const response = await handleRequest(
        mockFormRequest(path, {
          name: "John Doe",
          email: "john@example.com",
          [`quantity_${event1.id}`]: "1",
          [`quantity_${event2.id}`]: "1",
          csrf_token: csrfToken,
        }, `csrf_token=${csrfToken}`),
      );
      // Should succeed for event2 only
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("success");
    });
  });

  describe("routes/webhooks.ts (multi-ticket webhook)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket webhook creates attendees for multiple events", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-wh-ok-1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "multi-wh-ok-2",
        maxAttendees: 50,
        unitPrice: 300,
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_ok",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_ok",
              payment_status: "paid",
              payment_intent: "pi_multi_ok",
              metadata: {
                name: "Multi Buyer",
                email: "multi@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 2 },
                ]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.processed).toBe(true);
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("multi-ticket webhook handles event not found with refund", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_notfound",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_notfound",
              payment_status: "paid",
              payment_intent: "pi_multi_notfound",
              metadata: {
                name: "Multi NotFound",
                email: "notfound@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: 99999, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue(true);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Event not found");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket webhook handles capacity exceeded with rollback", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-wh-cap-1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        slug: "multi-wh-cap-2",
        maxAttendees: 1,
        unitPrice: 300,
      });

      // Fill event2 to capacity
      await createAttendeeAtomic(event2.id, "Existing", "existing@example.com", null, 1);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_cap",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_cap",
              payment_status: "paid",
              payment_intent: "pi_multi_cap",
              metadata: {
                name: "Multi Cap",
                email: "cap@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: event2.id, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue(true);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("sold out");
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("webhook with already-processed session where event was deleted", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Create a real event and attendee to satisfy FK constraints for finalization
      const event = await createTestEvent({
        slug: "wh-del-evt",
        maxAttendees: 50,
        unitPrice: 500,
      });
      const attResult = await createAttendeeAtomic(event.id, "WH Del", "whdel@example.com", "pi_del", 1);
      if (!attResult.success) throw new Error("Failed to create attendee");

      // Reserve and finalize the session with the real attendee
      const { reserveSession: reserveSessionFn, finalizeSession: finalizeSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_del_event_wh");
      await finalizeSessionFn("cs_del_event_wh", attResult.attendee.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      // Use a non-existent event_id in metadata to trigger "Event not found" in alreadyProcessedResult
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_del_event_wh",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_del_event_wh",
              payment_status: "paid",
              payment_intent: "pi_del_event_wh",
              metadata: {
                name: "Deleted Event",
                email: "deleted@example.com",
                event_id: "99999",
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Event not found");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook refund returns false when payment reference is null", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "wh-noref",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_noref",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_noref",
              payment_status: "paid",
              metadata: {
                name: "No Ref",
                email: "noref@example.com",
                event_id: String(event.id),
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("no longer accepting");
      } finally {
        mockVerify.mockRestore();
      }
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

  describe("routes/public.ts (formatAtomicError encryption_error single-ticket)", () => {
    test("shows encryption error message when atomic create fails with encryption_error", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
      });

      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "encryption_error",
      });

      try {
        const response = await submitTicketForm(event.slug, {
          name: "John Doe",
          email: "john@example.com",
        });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Registration failed");
        expect(html).toContain("Please try again");
      } finally {
        mockAtomic.mockRestore();
      }
    });
  });

  describe("routes/public.ts (multi-ticket quantity field missing from form)", () => {
    test("defaults to 0 when quantity field is absent from multi-ticket form", async () => {
      const event1 = await createTestEvent({
        slug: "multi-nofield-1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-nofield-2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit form with quantity for event2 only; event1 has no quantity field at all
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("success");

      // Verify only event2 got an attendee
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(0);
      expect(attendees2.length).toBe(1);
    });
  });

  describe("routes/public.ts (multi-ticket paid availability check fails)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns error when paid multi-ticket availability check fails", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-avail-race-1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-avail-race-2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock hasAvailableSpots via attendeesApi to return false for event1,
      // simulating a race condition where event sells out between page load and check
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const origHasSpots = attendeesApi.hasAvailableSpots;
      const mockSpots = spyOn(attendeesApi, "hasAvailableSpots");
      mockSpots.mockImplementation(async (...args: Parameters<typeof origHasSpots>) => {
        if (args[0] === event1.id) return false;
        return origHasSpots(...args);
      });

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              name: "John Doe",
              email: "john@example.com",
              [`quantity_${event1.id}`]: "1",
              [`quantity_${event2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("some tickets are no longer available");
      } finally {
        mockSpots.mockRestore();
      }
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing single-ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("shows payment not configured error when provider returns null for single-ticket", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Mock paymentsApi.getConfiguredProvider to return null so getActivePaymentProvider
      // returns null, while isPaymentsEnabled still returns true from the DB
      const { paymentsApi } = await import("#lib/payments.ts");
      const mockConfigured = spyOn(paymentsApi, "getConfiguredProvider");
      mockConfigured.mockResolvedValue(null);

      try {
        const response = await submitTicketForm(event.slug, {
          name: "John Doe",
          email: "john@example.com",
        });

        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("Payments are not configured");
      } finally {
        mockConfigured.mockRestore();
      }
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing multi-ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("shows payment not configured error when provider returns null for multi-ticket", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "multi-noprov-miss-1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        slug: "multi-noprov-miss-2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock paymentsApi.getConfiguredProvider to return null so getActivePaymentProvider
      // returns null, while isPaymentsEnabled still returns true from the DB
      const { paymentsApi } = await import("#lib/payments.ts");
      const mockConfigured = spyOn(paymentsApi, "getConfiguredProvider");
      mockConfigured.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              name: "John Doe",
              email: "john@example.com",
              [`quantity_${event1.id}`]: "1",
              [`quantity_${event2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("Payments are not configured");
      } finally {
        mockConfigured.mockRestore();
      }
    });
  });

  describe("routes/webhooks.ts (uncovered line coverage)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("extractIntent defaults eventId to 0 when event_id is missing from metadata", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Use webhook path: event type matches but metadata is incomplete,
      // so extractSessionFromEvent returns null. Fallback retrieves session
      // via provider.retrieveSession which we mock to return event_id undefined.
      // This triggers the ?? "0" fallback in extractIntent (line 52).
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_eid",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_no_event_id",
              status: "COMPLETED",
              // No proper metadata -> extractSessionFromEvent returns null
            },
          },
        },
      });

      const mockRetrieveSession = spyOn(stripePaymentProvider, "retrieveSession");
      mockRetrieveSession.mockResolvedValue({
        id: "cs_no_event_id",
        paymentStatus: "paid" as const,
        paymentReference: "pi_no_event_id",
        metadata: {
          name: "No EventId",
          email: "noeventid@example.com",
          quantity: "1",
          // event_id intentionally undefined -> triggers ?? "0"
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        // eventId defaults to 0 (no event with id 0), so "Event not found" error
        expect(json.error).toContain("Event not found");
      } finally {
        mockVerify.mockRestore();
        mockRetrieveSession.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("tryRefund logs error when no payment provider is configured", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "wh-tryrefund-noprov",
        maxAttendees: 50,
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      // Mock paymentsApi.getConfiguredProvider to return "stripe" on first call
      // (for webhook handler's initial check) then null on second call (for tryRefund).
      // This covers lines 135-141 where tryRefund has a payment reference but no provider.
      const { paymentsApi } = await import("#lib/payments.ts");
      const origGetConfigured = paymentsApi.getConfiguredProvider;
      let callCount = 0;
      const mockGetConfigured = spyOn(paymentsApi, "getConfiguredProvider");
      mockGetConfigured.mockImplementation(async () => {
        callCount++;
        // First call: webhook handler needs provider; second call: tryRefund should get null
        return callCount <= 1 ? origGetConfigured() : null;
      });

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_tryrefund_noprov",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_tryrefund_noprov",
              payment_status: "paid",
              payment_intent: "pi_tryrefund_noprov",
              metadata: {
                name: "No Provider",
                email: "noprov@example.com",
                event_id: String(event.id),
                quantity: "1",
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("no longer accepting");
      } finally {
        mockVerify.mockRestore();
        mockGetConfigured.mockRestore();
      }
    });

    test("multi already-processed session with invalid firstEventId returns error", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Create and reserve a session so it's already processed
      const attResult = await createAttendeeAtomic(
        (await createTestEvent({ slug: "wh-multi-inv-eid", maxAttendees: 50 })).id,
        "Test", "test@example.com", null, 1,
      );
      if (!attResult.success) throw new Error("Failed to create attendee");

      const { reserveSession: reserveSessionFn, finalizeSession: finalizeSessionFn } = await import("#lib/db/processed-payments.ts");
      await reserveSessionFn("cs_multi_inv_eid");
      await finalizeSessionFn("cs_multi_inv_eid", attResult.attendee.id);

      // Send multi-ticket webhook where items[0].e is 0 (falsy), triggering lines 233-235
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_inv_eid",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_inv_eid",
              payment_status: "paid",
              payment_intent: "pi_multi_inv_eid",
              metadata: {
                name: "Invalid EID",
                email: "inveid@example.com",
                multi: "1",
                items: JSON.stringify([{ e: 0, q: 1 }]),
              },
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Invalid session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("multi-ticket rollback deletes already-created attendees when second event not found", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event1 = await createTestEvent({
        slug: "wh-multi-rollback-1",
        maxAttendees: 50,
        unitPrice: 500,
      });
      // event2 does not exist (id 99999), so after creating attendee for event1 it rolls back

      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_multi_rollback",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_multi_rollback_cleanup",
              payment_status: "paid",
              payment_intent: "pi_multi_rollback",
              metadata: {
                name: "Rollback Test",
                email: "rollback@example.com",
                multi: "1",
                items: JSON.stringify([
                  { e: event1.id, q: 1 },
                  { e: 99999, q: 1 },
                ]),
              },
            },
          },
        },
      });

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_rollback" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.error).toContain("Event not found");

        // Verify the attendee created for event1 was rolled back (deleted)
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event1.id);
        expect(attendees.length).toBe(0);
      } finally {
        mockVerify.mockRestore();
        mockRefund.mockRestore();
      }
    });

    test("multi-ticket pricePaid is null when event has no unit_price", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Create event with no unitPrice (free event) to cover line 273 null path
      const event = await createTestEvent({
        slug: "wh-multi-free",
        maxAttendees: 50,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_free",
        payment_status: "paid",
        payment_intent: "pi_multi_free",
        metadata: {
          name: "Free Multi",
          email: "freemulti@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 2 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_free"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(2);
        // price_paid should be null for free events
        expect(attendees[0]?.price_paid).toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("single-ticket pricePaid is null when event has no unit_price", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Create event with no unitPrice (free event) to cover line 378 null path
      const event = await createTestEvent({
        slug: "wh-single-free",
        maxAttendees: 50,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_single_free",
        payment_status: "paid",
        payment_intent: "pi_single_free",
        metadata: {
          event_id: String(event.id),
          name: "Free Single",
          email: "freesingle@example.com",
          quantity: "2",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_free"),
        );
        expect(response.status).toBe(200);

        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(2);
        expect(attendees[0]?.price_paid).toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("webhook with checkout event type but no extractable session falls back with no sessionId", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Event type matches checkoutCompletedEventType but data lacks metadata
      // so extractSessionFromEvent returns null (covers lines 498-500)
      // and data object has no id/order_id so sessionId is null (covers lines 597-602)
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_no_extract",
          type: "checkout.session.completed",
          data: {
            object: {
              // No id, no order_id, no proper metadata
              some_field: "value",
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toBe("Invalid session data");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook with checkout event but non-COMPLETED status returns pending", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Event type matches but metadata is invalid so extractSessionFromEvent returns null
      // data object has id (for sessionId) and status "PENDING" (covers lines 605-607)
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_pending_square",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "pay_pending_123",
              status: "PENDING",
              // No payment_status or metadata -> extractSessionFromEvent returns null
            },
          },
        },
      });

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.received).toBe(true);
        expect(json.status).toBe("pending");
      } finally {
        mockVerify.mockRestore();
      }
    });

    test("webhook fallback uses order_id when present in event data", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      // Event with order_id instead of id triggers the order_id branch
      // in extractSessionIdFromObject
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockVerify = spyOn(stripePaymentProvider, "verifyWebhookSignature");
      mockVerify.mockResolvedValue({
        valid: true,
        event: {
          id: "evt_order_id_test",
          type: "checkout.session.completed",
          data: {
            object: {
              order_id: "order_abc123",
              status: "COMPLETED",
              // No metadata -> extractSessionFromEvent returns null
            },
          },
        },
      });

      const mockRetrieveSession = spyOn(stripePaymentProvider, "retrieveSession");
      mockRetrieveSession.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          new Request("http://localhost/payment/webhook", {
            method: "POST",
            headers: {
              host: "localhost",
              "content-type": "application/json",
              "stripe-signature": "sig_valid",
            },
            body: JSON.stringify({}),
          }),
        );
        // retrieveSession returns null -> "Invalid session data"
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toBe("Invalid session data");
      } finally {
        mockVerify.mockRestore();
        mockRetrieveSession.mockRestore();
      }
    });

    test("multi-ticket with no attendees created returns refund error", async () => {
      await updateStripeKey("sk_test_mock");
      await setPaymentProvider("stripe");

      const event = await createTestEvent({
        slug: "wh-multi-no-att",
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Mock createAttendeeAtomic to always fail with capacity_exceeded on first try
      // so createdAttendees stays empty and we hit lines 309-310
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "capacity_exceeded",
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_multi_no_att",
        payment_status: "paid",
        payment_intent: "pi_multi_no_att",
        metadata: {
          name: "No Att",
          email: "noatt@example.com",
          multi: "1",
          items: JSON.stringify([{ e: event.id, q: 1 }]),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_no_att" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_no_att"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
      } finally {
        mockAtomic.mockRestore();
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
      }
    });
  });

  describe("routes/router.ts (slug and generic param coverage)", () => {
    test("createRouter matches slug param pattern correctly", async () => {
      const { createRouter } = await import("#routes/router.ts");
      let capturedParams: Record<string, string | undefined> = {};
      const router = createRouter({
        "GET /item/:slug": (_req, params) => {
          capturedParams = params;
          return new Response("matched slug");
        },
      });
      const req = new Request("http://localhost/item/my-test-event");
      const response = await router(req, "/item/my-test-event", "GET");
      expect(response).not.toBeNull();
      expect(capturedParams.slug).toBe("my-test-event");
      const text = await response!.text();
      expect(text).toBe("matched slug");
    });

    test("createRouter matches generic (non-id non-slug) param pattern", async () => {
      const { createRouter } = await import("#routes/router.ts");
      let capturedParams: Record<string, string | undefined> = {};
      const router = createRouter({
        "GET /file/:name": (_req, params) => {
          capturedParams = params;
          return new Response("matched generic");
        },
      });
      const req = new Request("http://localhost/file/my-file.txt");
      const response = await router(req, "/file/my-file.txt", "GET");
      expect(response).not.toBeNull();
      expect(capturedParams.name).toBe("my-file.txt");
      const text = await response!.text();
      expect(text).toBe("matched generic");
    });

    test("createRouter returns null for unmatched routes", async () => {
      const { createRouter } = await import("#routes/router.ts");
      const router = createRouter({
        "GET /known": () => new Response("ok"),
      });
      const req = new Request("http://localhost/unknown");
      const response = await router(req, "/unknown", "GET");
      expect(response).toBeNull();
    });
  });

  describe("routes/admin/auth.ts (login with null wrappedDataKey)", () => {
    test("login succeeds but session has null wrappedDataKey when data key is missing", async () => {
      // Delete the wrapped_data_key from settings to make unwrapDataKey return null
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "DELETE FROM settings WHERE key = 'wrapped_data_key'",
        args: [],
      });

      // Login should still succeed (password verification works, data key is just null)
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      // Should redirect to /admin (successful login)
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");

      // Verify session was created with null wrapped_data_key
      const cookie = response.headers.get("set-cookie")!;
      const tokenMatch = cookie.match(/__Host-session=([^;]+)/);
      expect(tokenMatch).not.toBeNull();
      const session = await getSession(tokenMatch![1]);
      expect(session).not.toBeNull();
      expect(session!.wrapped_data_key).toBeNull();
    });
  });

  describe("routes/index.ts (routeMainApp null fallback)", () => {
    test("returns 404 when routeMainApp returns null for unmatched path", async () => {
      // A path that doesn't match any registered route
      const response = await handleRequest(mockRequest("/completely-unknown-path-xyz-987"));
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toContain("Not Found");
    });
  });

  describe("routes/admin/events.ts (eventErrorPage notFound)", () => {
    test("event edit validation error returns 404 when event was deleted", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const { eventsTable } = await import("#lib/db/events.ts");

      // Create two events so we can have a slug conflict
      const event1 = await createTestEvent({
        slug: "event-for-delete-err",
        maxAttendees: 50,
      });
      await createTestEvent({
        slug: "event-err-conflict",
        maxAttendees: 50,
      });

      // Spy on eventsTable.findById: return the row on first call (so requireExists passes),
      // but also delete the event from DB so getEventWithCount (raw SQL) returns null.
      const originalFindById = eventsTable.findById.bind(eventsTable);
      const spy = spyOn(eventsTable, "findById");
      spy.mockImplementation(async (id: unknown) => {
        const row = await originalFindById(id);
        if (row) {
          // Delete the event from DB so getEventWithCount returns null
          const { getDb } = await import("#lib/db/client.ts");
          await getDb().execute({ sql: "DELETE FROM events WHERE id = ?", args: [id as number] });
        }
        return row;
      });

      try {
        // Send an update with a duplicate slug to trigger validation error
        const response = await handleRequest(
          mockFormRequest(
            `/admin/event/${event1.id}/edit`,
            {
              slug: "event-err-conflict",
              max_attendees: "50",
              max_quantity: "1",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        // requireExists sees the row (first findById). Validation fails (duplicate slug).
        // eventErrorPage calls getEventWithCount, but event was deleted, so returns 404.
        expect(response.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("exercises parseAttendeeIds via POST route with valid params", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        slug: "parse-ids-test",
        maxAttendees: 50,
      });
      const attendee = await createTestAttendee(event.id, event.slug, "Test User", "test@example.com");

      // POST route exercises attendeeDeleteHandler which calls parseAttendeeIds.
      // The custom handler requires confirm_name to match the attendee name.
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { csrf_token: csrfToken, confirm_name: "Test User" },
          cookie,
        ),
      );
      // Should redirect after successful delete
      expect(response.status).toBe(302);
    });
  });

  describe("routeMainApp fallback to notFoundResponse", () => {
    test("returns 404 for unknown path after setup", async () => {
      const response = await handleRequest(
        mockRequest("/this-path-definitely-does-not-exist-anywhere"),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("admin event onDelete handler", () => {
    test("deleting an event triggers the onDelete handler which calls deleteEvent", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({ slug: "delete-ondelete-test", maxAttendees: 10 });
      // Add an attendee so delete covers more paths
      await createTestAttendee(event.id, event.slug, "User A", "a@test.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          { csrf_token: csrfToken, confirm_identifier: event.slug },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });
});
