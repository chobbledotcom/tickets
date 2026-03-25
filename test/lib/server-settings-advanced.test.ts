import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { getSessionCookieName } from "#lib/cookies.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { settings } from "#lib/db/settings.ts";
import { setDemoModeForTest } from "#lib/demo.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectAdminRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockFormRequest,
  mockRequest,
  mockRequestWithHost,
  setTestEnv,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
  withMockBunnyCdnApi,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings-advanced)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
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
      expect(html).toContain('id="settings-reset-database"');
    });

    test("shows host email label when host email is configured", async () => {
      const restore = setTestEnv({
        HOST_EMAIL_PROVIDER: "resend",
        HOST_EMAIL_API_KEY: "key-123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@example.com",
      });
      try {
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Host Resend (noreply@example.com)");
        expect(html).not.toContain("None (disabled)");
      } finally {
        restore();
      }
    });

    test("displays success message on the matching form when form param is provided", async () => {
      const response = await awaitTestRequest(
        `/admin/settings-advanced?form=settings-show-public-api&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader("API enabled")}`,
        },
      );
      const html = await response.text();
      expect(html).toContain('id="settings-show-public-api"');
      expect(html).toContain("API enabled");
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
      const { response } = await adminFormPost(
        "/admin/settings/show-public-api",
        { show_public_api: "true" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public API enabled"));
    });

    test("disables public API", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/show-public-api",
        { show_public_api: "false" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public API disabled"));
    });

    test("setting persists in database", async () => {
      const { settings } = await import("#lib/db/settings.ts");

      expect(settings.showPublicApi).toBe(false);

      await adminFormPost("/admin/settings/show-public-api", {
        show_public_api: "true",
      });

      expect(settings.showPublicApi).toBe(true);
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
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "resend",
        email_api_key: "re_test_123",
        email_from_address: "tickets@example.com",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email settings updated"));
    });

    test("disables email when provider is empty", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email provider disabled"));
    });

    test("rejects invalid email provider", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "invalid-provider",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid email provider"),
        false,
      );
    });

    test("rejects invalid from-address format", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "resend",
        email_api_key: "re_test_123",
        email_from_address: "not-an-email",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid from-address format"),
        false,
      );
    });

    test("disables email when provider field is missing", async () => {
      const { response } = await adminFormPost("/admin/settings/email");

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email provider disabled"));
    });

    test("saves provider without updating key when key is empty", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "postmark",
        email_api_key: "",
        email_from_address: "",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email settings updated"));
    });

    test("logs activity when email provider is set", async () => {
      await adminFormPost("/admin/settings/email", {
        email_provider: "sendgrid",
        email_api_key: "sg_key",
        email_from_address: "from@test.com",
      });

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
      const { response } = await adminFormPost("/admin/settings/email/test");

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Email not configured"),
        false,
      );
    });

    test("shows error when no business email set", async () => {
      const { settings } = await import("#lib/db/settings.ts");

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");

      const { response } = await adminFormPost("/admin/settings/email/test");

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("No business email set"),
        false,
      );
    });

    test("sends test email and redirects with success including status code", async () => {
      const { settings } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#lib/business-email.ts"
      );

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settings.invalidateCache();

      await withMocks(
        () => stub(globalThis, "fetch", () => Promise.resolve(new Response())),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/email/test",
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Test email sent (status 200)"),
          );
        },
      );
    });

    test("shows error when email API returns non-2xx status", async () => {
      const { settings } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#lib/business-email.ts"
      );

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settings.invalidateCache();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Forbidden", { status: 403 })),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/email/test",
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Test email failed (status 403)"),
            false,
          );
        },
      );
    });

    test("shows error when email send encounters network error", async () => {
      const { settings } = await import("#lib/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#lib/business-email.ts"
      );

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settings.invalidateCache();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.reject(new Error("Network error")),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/email/test",
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Test email failed (no response)"),
            false,
          );
        },
      );
    });
  });

  describe("settings-advanced page email provider display", () => {
    test("shows email provider when configured", async () => {
      const { settings } = await import("#lib/db/settings.ts");

      await settings.update.email.provider("resend");
      await settings.update.email.fromAddress("from@test.com");

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
      const { response } = await adminFormPost(
        "/admin/settings/reset-database",
        { confirm_phrase: "wrong phrase" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Confirmation phrase does not match"),
        false,
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
      expectRedirectWithFlash("/setup/", "Database reset")(response);
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(sessionCookie).toContain("Max-Age=0");
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
      const { response } = await adminFormPost(
        "/admin/settings/reset-database",
        { confirm_phrase: "" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Confirmation phrase does not match"),
        false,
      );
    });
  });

  describeWithEnv(
    "host subdomain",
    {
      env: {
        BUNNY_API_KEY: undefined,
        BUNNY_SCRIPT_ID: undefined,
        BUNNY_DNS_ZONE_ID: undefined,
        BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
      },
    },
    () => {
      let restoreCdnHostname: (() => void) | null = null;

      const setBunnyDnsEnv = () => {
        Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
        Deno.env.set("BUNNY_SCRIPT_ID", "test-script-id");
        Deno.env.set("BUNNY_DNS_ZONE_ID", "42");
        Deno.env.set("BUNNY_DNS_SUBDOMAIN_SUFFIX", ".tickets");
        const original = bunnyCdnApi.getCdnHostname;
        bunnyCdnApi.getCdnHostname = () =>
          Promise.resolve({ ok: true as const, hostname: "test.b-cdn.net" });
        restoreCdnHostname = () => {
          bunnyCdnApi.getCdnHostname = original;
        };
      };

      afterEach(() => {
        if (restoreCdnHostname) {
          restoreCdnHostname();
          restoreCdnHostname = null;
        }
      });

      test("does not show host subdomain section when DNS not configured", async () => {
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain('id="settings-host-subdomain"');
      });

      test("shows host subdomain section when DNS is configured", async () => {
        setBunnyDnsEnv();
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain('id="settings-host-subdomain"');
        expect(html).toContain("Host Subdomain");
        expect(html).toContain(
          "Check Availability &amp; Preview Complete Domain",
        );
      });

      describe("POST /admin/settings/host-subdomain", () => {
        test("rejects when DNS is not configured", async () => {
          Deno.env.delete("BUNNY_API_KEY");
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/host-subdomain",
              {
                subdomain: "myevent",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Not configured"),
            false,
          );
        });

        test("rejects when subdomain already set", async () => {
          setBunnyDnsEnv();
          const csrfToken = await testCsrfToken();
          const cookie = await testCookie();
          const token = cookie.split("=").slice(1).join("=");
          await settings.update.bunnySubdomain("existing.tickets.example.com");
          const response = await handleRequest(
            mockRequestWithHost(
              "/admin/settings/host-subdomain",
              "existing.tickets.example.com",
              {
                method: "POST",
                headers: {
                  cookie: `__Host-session=${token}`,
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: `subdomain=myevent&csrf_token=${encodeURIComponent(csrfToken)}`,
              },
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("already"), false);
        });

        test("rejects invalid subdomain format", async () => {
          setBunnyDnsEnv();
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/host-subdomain",
              {
                subdomain: "-invalid",
                csrf_token: await testCsrfToken(),
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Invalid subdomain"),
            false,
          );
        });

        test("previews subdomain availability without save", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  ok: true as const,
                  available: true,
                  fullDomain: "myevent.tickets.example.com",
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    subdomain: "myevent",
                    csrf_token: await testCsrfToken(),
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              const location = response.headers.get("location")!;
              expect(location).toContain("form=settings-host-subdomain");
              expectFlash(response, expect.stringContaining("is available"));
            },
          );
        });

        test("preview returns error when availability check fails", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  ok: false as const,
                  error: "DNS zone error",
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    subdomain: "myevent",
                    csrf_token: await testCsrfToken(),
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("DNS zone error"),
                false,
              );
            },
          );
        });

        test("preview returns error when subdomain is taken", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  ok: true as const,
                  available: false,
                  fullDomain: "myevent.tickets.example.com",
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    subdomain: "myevent",
                    csrf_token: await testCsrfToken(),
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("already taken"),
                false,
              );
            },
          );
        });

        test("registers subdomain with save flag, saves to DB, and logs activity", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              registerBunnySubdomain: () =>
                Promise.resolve({
                  ok: true as const,
                  fullDomain: "myevent.tickets.example.com",
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    subdomain: "myevent",
                    save: "1",
                    csrf_token: await testCsrfToken(),
                  },
                  await testCookie(),
                ),
              );
              expectRedirectWithFlash(
                "/admin/settings-advanced?form=settings-host-subdomain#settings-host-subdomain",
                "Subdomain registered: myevent.tickets.example.com",
              )(response);
              expect(settings.bunnySubdomain).toBe(
                "myevent.tickets.example.com",
              );
              const log = await getAllActivityLog();
              expect(
                log.some((e) =>
                  e.message.includes(
                    "Host subdomain set to myevent.tickets.example.com",
                  ),
                ),
              ).toBe(true);
            },
          );
        });

        test("returns error when registration fails", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              registerBunnySubdomain: () =>
                Promise.resolve({ ok: false as const, error: "DNS error" }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    subdomain: "myevent",
                    save: "1",
                    csrf_token: await testCsrfToken(),
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("DNS error"),
                false,
              );
            },
          );
        });

        test("rejects registration when a task is already in progress", async () => {
          setBunnyDnsEnv();
          await settings.update.currentTask("some-other-task");
          try {
            const response = await handleRequest(
              mockFormRequest(
                "/admin/settings/host-subdomain",
                {
                  subdomain: "myevent",
                  save: "1",
                  csrf_token: await testCsrfToken(),
                },
                await testCookie(),
              ),
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Another task is already in progress"),
            );
          } finally {
            await settings.update.currentTask("");
          }
        });
      });
    },
  );

  describeWithEnv(
    "custom domain",
    { env: { BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined } },
    () => {
      let restoreCdnHostname: (() => void) | null = null;
      afterEach(() => {
        if (restoreCdnHostname) {
          restoreCdnHostname();
          restoreCdnHostname = null;
        }
      });

      const setBunnyEnv = () => {
        Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
        Deno.env.set("BUNNY_SCRIPT_ID", "99");
        const original = bunnyCdnApi.getCdnHostname;
        bunnyCdnApi.getCdnHostname = () =>
          Promise.resolve({
            ok: true as const,
            hostname: "mysite.b-cdn.net",
          });
        restoreCdnHostname = () => {
          bunnyCdnApi.getCdnHostname = original;
        };
      };

      test("does not show custom domain form when Bunny CDN is not configured", async () => {
        Deno.env.delete("BUNNY_API_KEY");
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
        await settings.update.customDomain("tickets.example.com");
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain('id="settings-custom-domain-validate"');
        expect(html).toContain("CNAME");
        expect(html).toContain("tickets.example.com");
        // CDN hostname is fetched from the edge script API
        expect(html).toContain("mysite.b-cdn.net");
      });

      test("shows warning when custom domain is not validated", async () => {
        setBunnyEnv();
        await settings.update.customDomain("tickets.example.com");
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("not yet validated");
        expect(html).toContain("will not work until validation is complete");
      });

      test("does not show warning when custom domain is validated", async () => {
        setBunnyEnv();
        await settings.update.customDomain("tickets.example.com");
        await settings.update.customDomainLastValidated();
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain("not yet validated");
      });

      test("shows last validated timestamp when domain has been validated", async () => {
        setBunnyEnv();
        // Get session token before setting the validated custom domain,
        // then re-format the cookie for the secure domain cookie name.
        const cookie = await testCookie();
        const token = cookie.split("=").slice(1).join("=");
        await settings.update.customDomain("tickets.example.com");
        await settings.update.customDomainLastValidated();
        const response = await handleRequest(
          mockRequestWithHost(
            "/admin/settings-advanced",
            "tickets.example.com",
            {
              headers: { cookie: `__Host-session=${token}` },
            },
          ),
        );
        const html = await response.text();
        expect(html).toContain("Last validated:");
      });

      describe("POST /admin/settings/custom-domain", () => {
        test("rejects when Bunny CDN is not configured", async () => {
          Deno.env.delete("BUNNY_API_KEY");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
            { custom_domain: "tickets.example.com" },
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Bunny CDN is not configured"),
            false,
          );
        });

        test("saves and validates domain when validation succeeds", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain",
              { custom_domain: "tickets.example.com" },
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Custom domain saved and validated"),
            );
            expect(settings.customDomain).toBe("tickets.example.com");
            expect(settings.customDomainLastValidated).not.toBeNull();
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("saves domain with error message when validation fails", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({
              ok: false as const,
              error: "DNS not configured",
            });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain",
              { custom_domain: "tickets.example.com" },
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("validation failed"),
              false,
            );
            expectFlash(
              response,
              expect.stringContaining("DNS not configured"),
              false,
            );
            expect(settings.customDomain).toBe("tickets.example.com");
            expect(settings.customDomainLastValidated).toBe("");
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
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "Tickets.Example.COM",
            });
            expect(settings.customDomain).toBe("tickets.example.com");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("clears custom domain when empty", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
            { custom_domain: "" },
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Custom domain cleared"),
          );
          expect(settings.customDomain).toBe("");
        });

        test("clears domain when field is missing from form", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Custom domain cleared"),
          );
          expect(settings.customDomain).toBe("");
        });

        test("rejects invalid domain format", async () => {
          setBunnyEnv();
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
            { custom_domain: "not a domain!" },
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Invalid domain format"),
            false,
          );
        });

        test("logs activity when domain is set", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
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
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
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
          Deno.env.delete("BUNNY_API_KEY");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain/validate",
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Bunny CDN is not configured"),
            false,
          );
        });

        test("rejects when no custom domain is saved", async () => {
          setBunnyEnv();
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain/validate",
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("No custom domain"),
            false,
          );
        });

        test("calls Bunny API and saves timestamp on success", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain/validate",
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Custom domain validated successfully"),
            );
            const lastValidated = settings.customDomainLastValidated;
            expect(lastValidated).not.toBeNull();
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("returns error when Bunny API fails", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({
              ok: false as const,
              error: "Add hostname failed (400): Hostname already exists",
            });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain/validate",
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Add hostname failed"),
              false,
            );
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("logs activity on successful validation", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain/validate");
            const log = await getAllActivityLog();
            expect(
              log.some((e) => e.message.includes("Custom domain validated")),
            ).toBe(true);
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });
      });

      describe("current_task guard", () => {
        test("rejects custom-domain save when a task is already in progress", async () => {
          setBunnyEnv();
          await settings.update.currentTask("some-other-task");
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain",
              { custom_domain: "tickets.example.com" },
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Another task is already in progress"),
            );
          } finally {
            await settings.update.currentTask("");
          }
        });

        test("rejects custom-domain validate when a task is already in progress", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          await settings.update.currentTask("some-other-task");
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain/validate",
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Another task is already in progress"),
            );
          } finally {
            await settings.update.currentTask("");
          }
        });

        test("clears current_task after successful custom-domain save", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            expect(settings.currentTask).toBe("");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("clears current_task after failed custom-domain validation", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({
              ok: false as const,
              error: "DNS not configured",
            });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            expect(settings.currentTask).toBe("");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("clears current_task even when the task throws", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () => {
            throw new Error("network failure");
          };
          Deno.env.set("TEST_EXPECT_ERROR", "1");
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            expect(settings.currentTask).toBe("");
          } finally {
            Deno.env.delete("TEST_EXPECT_ERROR");
            bunnyCdnApi.validateCustomDomain = original;
          }
        });
      });
    },
  );
});
