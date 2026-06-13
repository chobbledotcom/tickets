import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  followRedirectWithFlash,
  mockFormRequest,
  mockRequestWithHost,
  setTestEnv,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
  withMockBunnyCdnApi,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings-advanced)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/settings-advanced", () => {
    testRequiresAuth("/admin/settings-advanced");

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

    test("renders with a payment provider configured", async () => {
      await settings.update.paymentProvider("square");
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Advanced Settings");
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
        HOST_EMAIL_API_KEY: "key-123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@example.com",
        HOST_EMAIL_PROVIDER: "resend",
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
    testRequiresAuth("/admin/settings/show-public-api", {
      body: {
        show_public_api: "true",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-api",
          {
            csrf_token: "invalid-csrf-token",
            show_public_api: "true",
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
      const { settings } = await import("#shared/db/settings.ts");

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
    testRequiresAuth("/admin/settings/email", {
      body: {
        email_provider: "resend",
      },
      method: "POST",
    });

    test("saves email provider settings", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_api_key: "re_test_123",
        email_from_address: "tickets@example.com",
        email_provider: "resend",
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
        email_api_key: "re_test_123",
        email_from_address: "not-an-email",
        email_provider: "resend",
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
        email_api_key: "",
        email_from_address: "",
        email_provider: "postmark",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email settings updated"));
    });

    test("logs activity when email provider is set", async () => {
      await adminFormPost("/admin/settings/email", {
        email_api_key: "sg_key",
        email_from_address: "from@test.com",
        email_provider: "sendgrid",
      });

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message === "Email settings updated")).toBe(
        true,
      );
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
      const { settings } = await import("#shared/db/settings.ts");

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
      const { settings } = await import("#shared/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#shared/business-email.ts"
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
      const { settings } = await import("#shared/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#shared/business-email.ts"
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
      const { settings } = await import("#shared/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#shared/business-email.ts"
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
      const { settings } = await import("#shared/db/settings.ts");

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
    testRequiresAuth("/admin/settings/reset-database", {
      body: {
        confirm_phrase:
          "The site will be fully reset and all data will be lost.",
      },
      method: "POST",
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
        maxAttendees: 100,
        name: "Test Event",
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
        BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
        BUNNY_DNS_ZONE_ID: undefined,
        BUNNY_SCRIPT_ID: undefined,
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
          Promise.resolve({ hostname: "test.b-cdn.net", ok: true as const });
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

      test("shows registered subdomain and custom domain text", async () => {
        setBunnyDnsEnv();
        const cookie = await testCookie();
        const token = cookie.split("=").slice(1).join("=").split(";")[0];
        await settings.update.bunnySubdomain("myevent.tickets.example.com");
        const response = await handleRequest(
          mockRequestWithHost(
            "/admin/settings-advanced",
            "myevent.tickets.example.com",
            {
              headers: {
                cookie: `__Host-session=${token}`,
              },
            },
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("myevent.tickets.example.com");
        expect(html).toContain("permanent and cannot be changed");
        expect(html).toContain("can be active at the same time");
      });

      describe("POST /admin/settings/host-subdomain", () => {
        test("rejects when DNS is not configured", async () => {
          Deno.env.delete("BUNNY_API_KEY");
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/host-subdomain",
              {
                csrf_token: await testCsrfToken(),
                subdomain: "myevent",
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
                body: `subdomain=myevent&csrf_token=${encodeURIComponent(
                  csrfToken,
                )}`,
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  cookie: `__Host-session=${token}`,
                },
                method: "POST",
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
                csrf_token: await testCsrfToken(),
                subdomain: "-invalid",
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
                  available: true,
                  fullDomain: "myevent.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "myevent",
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

        test("renders subdomain preview on page after availability check", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  available: true,
                  fullDomain: "myevent.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const cookie = await testCookie();
              const postResponse = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "myevent",
                  },
                  cookie,
                ),
              );
              const page = await followRedirectWithFlash(
                postResponse,
                handleRequest,
                cookie,
              );
              const html = await page.text();
              expect(html).toContain("myevent.tickets.example.com");
              expect(html).toContain("is available");
            },
          );
        });

        test("preview returns error when availability check fails", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  error: "DNS zone error",
                  ok: false as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "myevent",
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
                  available: false,
                  fullDomain: "myevent.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "myevent",
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
                  fullDomain: "myevent.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    save: "1",
                    subdomain: "myevent",
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
                Promise.resolve({ error: "DNS error", ok: false as const }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    save: "1",
                    subdomain: "myevent",
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
                  csrf_token: await testCsrfToken(),
                  save: "1",
                  subdomain: "myevent",
                },
                await testCookie(),
              ),
            );
            expectRedirectWithFlash(
              "/admin/settings-advanced?form=settings-host-subdomain#settings-host-subdomain",
              expect.stringContaining("Another task is already in progress"),
              false,
            )(response);
          } finally {
            await settings.update.currentTask("");
          }
        });
      });
    },
  );
});
