import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import {
  getCustomDomainFromDb,
  getCustomDomainLastValidatedFromDb,
  getTimezoneFromDb,
  updateCustomDomain,
  updateCustomDomainLastValidated,
} from "#lib/db/settings.ts";
import { setDemoModeForTest } from "#lib/demo.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  expectRedirect,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
  withMocks,
} from "#test-utils";

describe("server (admin settings-advanced)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    setDemoModeForTest(false);
    resetDb();
  });

  describe("GET /admin/settings-advanced", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/settings-advanced"),
      );
      expectAdminRedirect(response);
    });

    test("shows advanced settings page when authenticated", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Advanced Settings",
        "Enable public API?",
      );
    });

    test("shows warning about careful changes", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Be careful changing settings on this page");
    });

    test("shows breadcrumb back to settings", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('href="/admin/settings"');
      expect(html).toContain("Settings");
    });

    test("each advanced settings form has an id attribute", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('id="settings-show-public-api"');
      expect(html).toContain('id="settings-apple-wallet"');
      expect(html).toContain('id="settings-email-tpl-confirmation"');
      expect(html).toContain('id="settings-email-tpl-admin"');
      expect(html).toContain('id="settings-email"');
      expect(html).toContain('id="settings-timezone"');
      expect(html).toContain('id="settings-reset-database"');
    });

    test("shows host email label when host email is configured", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      try {
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Host Resend (noreply@example.com)");
        expect(html).not.toContain("None (disabled)");
      } finally {
        Deno.env.delete("HOST_EMAIL_PROVIDER");
        Deno.env.delete("HOST_EMAIL_API_KEY");
        Deno.env.delete("HOST_EMAIL_FROM_ADDRESS");
      }
    });

    test("displays success message on the matching form when form param is provided", async () => {
      const response = await awaitTestRequest(
        "/admin/settings-advanced?success=Timezone+updated&form=settings-timezone",
        { cookie: await testCookie() },
      );
      const html = await response.text();
      expect(html).toContain('id="settings-timezone"');
      expect(html).toContain("Timezone updated");
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "America/New_York", csrf_token: "invalid-csrf-token" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves valid timezone", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "America/New_York", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/admin/settings-advanced");
      expect(location).toContain("form=settings-timezone");
      expect(location).toContain("#settings-timezone");
      const saved = await getTimezoneFromDb();
      expect(saved).toBe("America/New_York");
    });

    test("rejects empty timezone", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Timezone is required");
    });

    test("rejects invalid timezone string", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          {
            timezone: "Not/A/Real/Timezone",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Invalid timezone");
    });

    test("trims whitespace from timezone value", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/timezone",
          { timezone: "  Europe/London  ", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      const saved = await getTimezoneFromDb();
      expect(saved).toBe("Europe/London");
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "true",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("enables public API", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "true",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
        "Public API enabled",
      );
    });

    test("disables public API", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "false",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
        "Public API disabled",
      );
    });

    test("setting persists in database", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      expect(await settingsApi.getShowPublicApiFromDb()).toBe(false);

      await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            show_public_api: "true",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(await settingsApi.getShowPublicApiFromDb()).toBe(true);
    });

    test("advanced settings page displays enable public API section", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Enable public API?",
        "show_public_api",
      );
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: "re_test_123",
            email_from_address: "tickets@example.com",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
        "Email settings updated",
      );
    });

    test("disables email when provider is empty", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
        "Email provider disabled",
      );
    });

    test("rejects invalid email provider", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "invalid-provider",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "Invalid email provider");
    });

    test("rejects invalid from-address format", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "resend",
            email_api_key: "re_test_123",
            email_from_address: "not-an-email",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "Invalid from-address format");
    });

    test("disables email when provider field is missing", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expect(
        decodeURIComponent(
          response.headers.get("location")?.replaceAll("+", " "),
        ),
      ).toContain("Email provider disabled");
    });

    test("saves provider without updating key when key is empty", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "postmark",
            email_api_key: "",
            email_from_address: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expect(
        decodeURIComponent(
          response.headers.get("location")?.replaceAll("+", " "),
        ),
      ).toContain("Email settings updated");
    });

    test("logs activity when email provider is set", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            email_provider: "sendgrid",
            email_api_key: "sg_key",
            email_from_address: "from@test.com",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Email provider set to sendgrid")),
      ).toBe(true);
    });

    test("advanced settings page displays email configuration section", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('id="settings-email"');
      expect(html).toContain("email_provider");
      expect(html).toContain("Email Notifications");
    });
  });

  describe("POST /admin/settings/email/test", () => {
    test("shows error when email not configured", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email/test",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "Email not configured");
    });

    test("shows error when no business email set", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email/test",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );

      await expectHtmlResponse(response, 400, "No business email set");
    });

    test("sends test email and redirects with success including status code", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#lib/business-email.ts"
      );

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
              { csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );

          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
            "Test email sent (status 200)",
          );
        },
      );
    });

    test("shows error when email API returns non-2xx status", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#lib/business-email.ts"
      );

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settingsApi.invalidateSettingsCache();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Forbidden", { status: 403 })),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/email/test",
              { csrf_token: await testCsrfToken() },
              await testCookie(),
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
      const { updateBusinessEmail: setBizEmail } = await import(
        "#lib/business-email.ts"
      );

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailApiKey("re_test_key");
      await settingsApi.updateEmailFromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settingsApi.invalidateSettingsCache();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.reject(new Error("Network error")),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/email/test",
              { csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );

          const html = await response.text();
          expect(response.status).toBe(502);
          expect(html).toContain("Test email failed (no response)");
        },
      );
    });
  });

  describe("settings-advanced page email provider display", () => {
    test("shows email provider when configured", async () => {
      const { settingsApi } = await import("#lib/db/settings.ts");

      await settingsApi.updateEmailProvider("resend");
      await settingsApi.updateEmailFromAddress("from@test.com");

      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('value="resend"');
      expect(html).toContain("Send Test Email");
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects wrong confirmation phrase", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase: "wrong phrase",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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
      expectRedirect("/setup/?success=Database+reset")(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    test("advanced settings page shows reset database section", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(response, 200, "Reset Database");
      expect(html).toContain(
        "The site will be fully reset and all data will be lost.",
      );
      expect(html).toContain("confirm_phrase");
    });
  });

  describe("POST /admin/settings/reset-database (confirm phrase)", () => {
    test("rejects empty confirm phrase", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase: "",
            csrf_token: await testCsrfToken(),
          },
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
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).not.toContain('id="settings-custom-domain"');
    });

    test("shows custom domain form when Bunny CDN is configured", async () => {
      setBunnyEnv();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('id="settings-custom-domain"');
      expect(html).toContain("Custom Domain");
    });

    test("does not show validate form when no custom domain is saved", async () => {
      setBunnyEnv();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).not.toContain('id="settings-custom-domain-validate"');
    });

    test("shows validate form and CNAME instructions when custom domain is saved", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
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
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("not yet validated");
      expect(html).toContain("will not work until validation is complete");
    });

    test("does not show warning when custom domain is validated", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      await updateCustomDomainLastValidated();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).not.toContain("not yet validated");
    });

    test("shows last validated timestamp when domain has been validated", async () => {
      setBunnyEnv();
      await updateCustomDomain("tickets.example.com");
      await updateCustomDomainLastValidated();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Last validated:");
    });

    describe("POST /admin/settings/custom-domain", () => {
      test("rejects when Bunny CDN is not configured", async () => {
        clearBunnyEnv();
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/custom-domain",
            {
              custom_domain: "tickets.example.com",
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );
        expect(response.status).toBe(400);
      });

      test("saves and validates domain when validation succeeds", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: true as const });
        try {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain",
              {
                custom_domain: "tickets.example.com",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
            "Custom domain saved and validated",
          );
          expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
          expect(await getCustomDomainLastValidatedFromDb()).not.toBeNull();
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("saves domain with error message when validation fails", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: false as const, error: "DNS not configured" });
        try {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain",
              {
                custom_domain: "tickets.example.com",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          const decoded = decodeURIComponent(location.replaceAll("+", " "));
          expect(decoded).toContain("validation failed");
          expect(decoded).toContain("DNS not configured");
          expect(decoded).toContain("error=");
          expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
          expect(await getCustomDomainLastValidatedFromDb()).toBeNull();
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("normalizes domain to lowercase", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: true as const });
        try {
          await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain",
              {
                custom_domain: "Tickets.Example.COM",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("clears custom domain when empty", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/custom-domain",
            {
              custom_domain: "",
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location")!;
        expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
          "Custom domain cleared",
        );
        expect(await getCustomDomainFromDb()).toBeNull();
      });

      test("clears domain when field is missing from form", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/custom-domain",
            {
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location")!;
        expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
          "Custom domain cleared",
        );
        expect(await getCustomDomainFromDb()).toBeNull();
      });

      test("rejects invalid domain format", async () => {
        setBunnyEnv();
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/custom-domain",
            {
              custom_domain: "not a domain!",
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );
        await expectHtmlResponse(response, 400, "Invalid domain format");
      });

      test("logs activity when domain is set", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: true as const });
        try {
          await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain",
              {
                custom_domain: "tickets.example.com",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          const log = await getAllActivityLog();
          expect(
            log.some((e) =>
              e.message.includes("Custom domain set to tickets.example.com"),
            ),
          ).toBe(true);
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });

      test("logs validation activity when save triggers successful validation", async () => {
        setBunnyEnv();
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: true as const });
        try {
          await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain",
              {
                custom_domain: "tickets.example.com",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          const log = await getAllActivityLog();
          expect(
            log.some((e) => e.message.includes("Custom domain validated")),
          ).toBe(true);
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });
    });

    describe("POST /admin/settings/custom-domain/validate", () => {
      test("rejects when Bunny CDN is not configured", async () => {
        clearBunnyEnv();
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/custom-domain/validate",
            {
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );
        expect(response.status).toBe(400);
      });

      test("rejects when no custom domain is saved", async () => {
        setBunnyEnv();
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/custom-domain/validate",
            {
              csrf_token: await testCsrfToken(),
            },
            await testCookie(),
          ),
        );
        expect(response.status).toBe(400);
      });

      test("calls Bunny API and saves timestamp on success", async () => {
        setBunnyEnv();
        await updateCustomDomain("tickets.example.com");
        const original = bunnyCdnApi.validateCustomDomain;
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: true as const });
        try {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain/validate",
              {
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
            "Custom domain validated successfully",
          );
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
          Promise.resolve({
            ok: false as const,
            error: "Add hostname failed (400): Hostname already exists",
          });
        try {
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain/validate",
              {
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
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
        bunnyCdnApi.validateCustomDomain = () =>
          Promise.resolve({ ok: true as const });
        try {
          await handleRequest(
            mockFormRequest(
              "/admin/settings/custom-domain/validate",
              {
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          const log = await getAllActivityLog();
          expect(
            log.some((e) => e.message.includes("Custom domain validated")),
          ).toBe(true);
        } finally {
          bunnyCdnApi.validateCustomDomain = original;
        }
      });
    });
  });
});
