import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { buildFlashCookie } from "#shared/cookies.ts";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectHtml,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest, withMockBunnyCdnApi } from "#test-utils/mocks.ts";
import { secureAdminCookie, secureAdminGet } from "#test-utils/secure-admin.ts";
import { adminGet, testCookie } from "#test-utils/session.ts";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  const expectSettingsFormFlash = async (
    path: string,
    formId: string,
    flashMessage: string,
    opts: { contains?: string[]; notContains?: string[] } = {},
  ): Promise<string> => {
    const response = await awaitTestRequest(
      `${path}?form=${formId}&flash=${FLASH_TEST_ID}`,
      {
        cookie: `${await testCookie()}; ${flashCookieHeader(flashMessage)}`,
      },
    );
    return expectHtml(response, opts);
  };

  const advancedPageWithResult = async (result: string): Promise<string> => {
    const flashCookie = buildFlashCookie(
      FLASH_TEST_ID,
      "Subdomain available",
      true,
      result,
    ).split(";")[0]!;
    const response = await awaitTestRequest(
      `/admin/settings-advanced?flash=${FLASH_TEST_ID}`,
      { cookie: `${await testCookie()}; ${flashCookie}` },
    );
    expect(response.status).toBe(200);
    return await response.text();
  };

  const withCdnHostname = async (
    result: Awaited<ReturnType<typeof bunnyCdnApi.getCdnHostname>>,
    body: () => Promise<void>,
  ): Promise<void> => {
    using _env = withEnv({
      BUNNY_API_KEY: "bunny-key",
      BUNNY_SCRIPT_ID: "script-id",
    });
    await withMockBunnyCdnApi(
      { getCdnHostname: () => Promise.resolve(result) },
      body,
    );
  };

  describe("GET /admin/settings", () => {
    testRequiresAuth("/admin/settings");

    test("shows settings page when authenticated", async () => {
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Settings", "Change Password");
    });

    test("selects the exact empty payment state", async () => {
      const html = await (await adminGet("/admin/settings")).text();
      expect(html).toMatch(
        /<input checked name="payment_provider" type="radio" value="none">/,
      );
      expect(html).toContain("None (payments disabled)");
    });

    test("shows that an empty Square webhook key is not configured", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.accessToken("square-token");

      const html = await (await adminGet("/admin/settings")).text();

      expect(html).toContain(
        "No webhook signature key is configured. Follow the steps above to set one up.",
      );
      expect(html).not.toContain(
        "A webhook signature key is currently configured.",
      );
    });

    test("shows a flash with no form target as a page-level banner", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader(
            "Test success message",
          )}`,
        },
      );
      const html = await response.text();
      // With no ?form= target, no CsrfForm claims the flash, so the Layout
      // backstop renders it — surfacing it rather than the old behavior of
      // silently swallowing an unattributed flash.
      expect(html).toContain('class="success"');
      expect(html).toContain("Test success message");
    });

    test("displays success message on the matching form when form param is provided", async () => {
      const html = await expectSettingsFormFlash(
        "/admin/settings",
        "settings-business-email",
        "Business email updated",
        {
          contains: ['id="settings-business-email"', "Business email updated"],
        },
      );
      // The success message should be inside the form, not as a global banner
      const formMatch = html.match(
        /id="settings-business-email"[\s\S]*?<\/form>/,
      );
      expect(formMatch).toBeDefined();
      expect(formMatch?.[0]).toContain("Business email updated");
    });

    test("does not show success on non-matching forms", async () => {
      const html = await expectSettingsFormFlash(
        "/admin/settings",
        "settings-business-email",
        "Business email updated",
      );
      // The theme form should not contain the success message
      const themeFormMatch = html.match(/id="settings-theme"[\s\S]*?<\/form>/);
      expect(themeFormMatch).toBeDefined();
      expect(themeFormMatch?.[0]).not.toContain("Business email updated");
    });

    test("does not render the country form (locale is write-once, set at /setup)", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      // Country/locale can only be set during setup, then changed by an admin
      // editing the database — there is no editor on the settings page.
      expect(html).not.toContain('id="settings-country"');
      expect(html).not.toContain("/admin/settings/country");
    });

    test("each settings form has an id attribute", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).toContain('id="settings-business-email"');
      expect(html).toContain('id="settings-payment-provider"');
      expect(html).toContain('id="settings-embed-hosts"');
      expect(html).toContain('id="settings-terms"');
      expect(html).toContain('id="settings-password"');
      expect(html).toContain('id="settings-theme"');
      expect(html).not.toContain("/admin/settings/show-public-site");
    });

    test("shows settings sub-navigation", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).toContain('href="/admin/settings-advanced"');
      expect(html).toContain('href="/admin/backup"');
      expect(html).toContain('href="/admin/debug"');
    });
  });

  describe("GET /admin/settings-advanced", () => {
    testRequiresAuth("/admin/settings-advanced");

    test("shows advanced settings page when authenticated", async () => {
      const response = await adminGet("/admin/settings-advanced");
      await expectHtmlResponse(
        response,
        200,
        "Advanced Settings",
        "Enable public API?",
      );
    });

    test("the email variable table describes every variable", async () => {
      const html = await (await adminGet("/admin/settings-advanced")).text();

      // Rendering the page reads every row, and a missing key throws there, so
      // a 200 with this wording is proof the whole table resolved.
      expect(html).toContain("Link to view the tickets");
      expect(html).toContain("Picks the singular or plural word for a number");
    });

    test("shows exact empty host settings and scheduled-key state", async () => {
      using _env = withEnv({
        APPLE_WALLET_PASS_TYPE_ID: undefined,
        BUNNY_API_KEY: undefined,
        BUNNY_DNS_ZONE_ID: undefined,
        BUNNY_SCRIPT_ID: undefined,
        GOOGLE_WALLET_ISSUER_ID: undefined,
        HOST_EMAIL_PROVIDER: undefined,
        SCHEDULED_TASK_KEY: undefined,
      });
      settings.appleWallet.setHostConfigForTest(null);
      settings.googleWallet.setHostConfigForTest(null);
      try {
        const html = await (await adminGet("/admin/settings-advanced")).text();
        expect(html).toContain(">None (disabled)</option>");
        expect(html).toContain(
          "No scheduled maintenance key is set on this site.",
        );
        expect(html).not.toContain("Currently using:");
      } finally {
        settings.appleWallet.resetHostConfig();
        settings.googleWallet.resetHostConfig();
      }
    });

    test("shows the exact configured wallet host labels", async () => {
      settings.appleWallet.setHostConfigForTest({
        passTypeId: "pass.com.host.tickets",
        signingCert: "cert-data",
        signingKey: "key-data",
        teamId: "HOSTTEAM01",
        wwdrCert: "wwdr-data",
      });
      settings.googleWallet.setHostConfigForTest({
        issuerId: "3388000000012345678",
        serviceAccountEmail: "wallet@example.com",
        serviceAccountKey: "key-data",
      });
      try {
        const html = await (await adminGet("/admin/settings-advanced")).text();
        expect(html).toContain(
          "Currently using: Host env (pass.com.host.tickets).",
        );
        expect(html).toContain(
          "Currently using: Host env (3388000000012345678).",
        );
      } finally {
        settings.appleWallet.resetHostConfig();
        settings.googleWallet.resetHostConfig();
      }
    });

    test("shows the exact DNS suffix without a pending preview", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "bunny-key",
        BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets.test",
        BUNNY_DNS_ZONE_ID: "zone-id",
        BUNNY_SCRIPT_ID: undefined,
      });

      const html = await (await adminGet("/admin/settings-advanced")).text();

      expect(html).toContain('<span class="muted">.tickets.test</span>');
      expect(html).not.toContain("is available.");
    });

    test("splits an exact subdomain preview from its full domain", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "bunny-key",
        BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets.test",
        BUNNY_DNS_ZONE_ID: "zone-id",
        BUNNY_SCRIPT_ID: undefined,
      });

      const html = await advancedPageWithResult(
        "my-site\nmy-site.tickets.test",
      );

      expect(html).toContain("<strong>my-site.tickets.test</strong>");
      expect(html).toContain(
        '<input name="subdomain" type="hidden" value="my-site">',
      );
    });

    test("uses an empty full domain when a preview result has one line", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "bunny-key",
        BUNNY_DNS_ZONE_ID: "zone-id",
        BUNNY_SCRIPT_ID: undefined,
      });

      const html = await advancedPageWithResult("my-site");

      expect(html).toContain("<strong></strong>");
      expect(html).toContain(
        '<input name="subdomain" type="hidden" value="my-site">',
      );
    });

    test("shows an unvalidated custom domain and exact empty CDN target", () =>
      withCdnHostname({ error: "unavailable", ok: false }, async () => {
        await settings.update.customDomain("tickets.example.com");

        const html = await (await adminGet("/admin/settings-advanced")).text();

        expect(html).toContain("Your custom domain is not yet validated.");
        expect(html).toContain("<strong>Value:</strong> <code></code>");
        expect(html).not.toContain("Last validated:");
      }));

    test("shows the exact validated custom domain and CDN target", () =>
      withCdnHostname({ hostname: "site.b-cdn.net", ok: true }, async () => {
        const cookie = await secureAdminCookie();
        await settings.update.customDomain("tickets.example.com");
        await settings.update.customDomainLastValidated();
        const validatedAt = settings.customDomainLastValidated;

        const response = await secureAdminGet(
          "/admin/settings-advanced",
          "tickets.example.com",
          cookie,
        );
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(html).toContain("<code>tickets.example.com</code>");
        expect(html).toContain(
          "<strong>Value:</strong> <code>site.b-cdn.net</code>",
        );
        expect(html).toContain(`Last validated: ${validatedAt}`);
      }));

    test("keeps an empty custom domain empty when Bunny CDN is configured", () =>
      withCdnHostname({ hostname: "site.b-cdn.net", ok: true }, async () => {
        const html = await (await adminGet("/admin/settings-advanced")).text();

        expect(html).not.toContain("Your custom domain is not yet validated.");
        expect(html).not.toContain("Last validated:");
      }));

    test("shows warning about careful changes", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain("Be careful changing settings on this page");
    });

    test("renders with a payment provider configured", async () => {
      await settings.update.paymentProvider("square");
      const response = await adminGet("/admin/settings-advanced");
      await expectHtmlResponse(response, 200, "Advanced Settings");
    });

    test("shows breadcrumb back to settings", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain('href="/admin/settings"');
      expect(html).toContain("Settings");
    });

    test("each advanced settings form has an id attribute", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain('id="settings-show-public-api"');
      expect(html).toContain('id="settings-apple-wallet"');
      expect(html).toContain('id="settings-email-tpl-confirmation"');
      expect(html).toContain('id="settings-email-tpl-admin"');
      expect(html).toContain('id="settings-email"');
      expect(html).toContain('id="settings-reset-database"');
    });

    test("shows host email label when host email is configured", async () => {
      using _env = withEnv({
        HOST_EMAIL_API_KEY: "key-123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@example.com",
        HOST_EMAIL_PROVIDER: "resend",
      });
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain("Host Resend (noreply@example.com)");
      expect(html).not.toContain("None (disabled)");
    });

    test("displays success message on the matching form when form param is provided", async () => {
      await expectSettingsFormFlash(
        "/admin/settings-advanced",
        "settings-show-public-api",
        "API enabled",
        {
          contains: ['id="settings-show-public-api"', "API enabled"],
        },
      );
    });
  });
});
