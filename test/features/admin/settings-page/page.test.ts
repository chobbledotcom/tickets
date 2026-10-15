import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import type { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { buildFlashCookie } from "#shared/cookies.ts";
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
import { says, saysNot } from "#test-utils/says.ts";
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
      says(html, "None (payments disabled)");
    });

    test("shows that an empty Square webhook key is not configured", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.accessToken("square-token");

      const html = await (await adminGet("/admin/settings")).text();

      says(
        html,
        "No webhook signature key is configured. Follow the steps above to set one up.",
      );
      assert(
        !html.includes("A webhook signature key is currently configured."),
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
      says(html, 'class="success"');
      says(html, "Test success message");
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
      says(formMatch?.[0], "Business email updated");
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
      saysNot(
        themeFormMatch?.[0],
        "Business email updated",
        "the value should not contain the searched item",
      );
    });

    test("does not render the country form (locale is write-once, set at /setup)", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      // Country/locale can only be set during setup, then changed by an admin
      // editing the database — there is no editor on the settings page.
      assert(!html.includes('id="settings-country"'));
      assert(!html.includes("/admin/settings/country"));
    });

    test("each settings form has an id attribute", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      says(html, 'id="settings-business-email"');
      says(html, 'id="settings-payment-provider"');
      says(html, 'id="settings-embed-hosts"');
      says(html, 'id="settings-terms"');
      says(html, 'id="settings-password"');
      says(html, 'id="settings-theme"');
      assert(!html.includes("/admin/settings/show-public-site"));
    });

    test("shows settings sub-navigation", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      says(html, 'href="/admin/settings-advanced"');
      says(html, 'href="/admin/backup"');
      says(html, 'href="/admin/debug"');
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
      says(html, "Link to view the tickets");
      says(html, "Picks the singular or plural word for a number");
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
        says(html, ">None (disabled)</option>");
        says(html, "No scheduled maintenance key is set on this site.");
        assert(!html.includes("Currently using:"));
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
        says(html, "Currently using: Host env (pass.com.host.tickets).");
        says(html, "Currently using: Host env (3388000000012345678).");
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

      says(html, '<span class="muted">.tickets.test</span>');
      // No pending preview: the hidden subdomain input only appears after a
      // successful check.
      assert(!html.includes('<input name="subdomain" type="hidden"'));
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

      says(html, "<strong>my-site.tickets.test</strong>");
      says(html, '<input name="subdomain" type="hidden" value="my-site">');
    });

    test("uses an empty full domain when a preview result has one line", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "bunny-key",
        BUNNY_DNS_ZONE_ID: "zone-id",
        BUNNY_SCRIPT_ID: undefined,
      });

      const html = await advancedPageWithResult("my-site");

      says(html, "<strong></strong>");
      says(html, '<input name="subdomain" type="hidden" value="my-site">');
    });

    test("shows an unvalidated custom domain and exact empty CDN target", () =>
      withCdnHostname({ error: "unavailable", ok: false }, async () => {
        await settings.update.customDomain("tickets.example.com");

        const html = await (await adminGet("/admin/settings-advanced")).text();

        says(html, "Your custom domain is not yet validated.");
        says(html, "<strong>Value:</strong> <code></code>");
        assert(!html.includes("Last validated:"));
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
        says(html, "<code>tickets.example.com</code>");
        says(html, "<strong>Value:</strong> <code>site.b-cdn.net</code>");
        says(html, `Last validated: ${validatedAt}`);
      }));

    test("keeps an empty custom domain empty when Bunny CDN is configured", () =>
      withCdnHostname({ hostname: "site.b-cdn.net", ok: true }, async () => {
        const html = await (await adminGet("/admin/settings-advanced")).text();

        assert(!html.includes("Your custom domain is not yet validated."));
        assert(!html.includes("Last validated:"));
      }));

    test("shows warning about careful changes", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      says(html, "Be careful changing settings on this page");
    });

    test("renders with a payment provider configured", async () => {
      await settings.update.paymentProvider("square");
      const response = await adminGet("/admin/settings-advanced");
      await expectHtmlResponse(response, 200, "Advanced Settings");
    });

    test("shows breadcrumb back to settings", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      says(html, 'href="/admin/settings"');
      says(html, "Settings");
    });

    test("each advanced settings form has an id attribute", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      says(html, 'id="settings-show-public-api"');
      says(html, 'id="settings-apple-wallet"');
      says(html, 'id="settings-email-tpl-confirmation"');
      says(html, 'id="settings-email-tpl-admin"');
      says(html, 'id="settings-email"');
      says(html, 'id="settings-reset-database"');
    });

    test("shows host email label when host email is configured", async () => {
      using _env = withEnv({
        HOST_EMAIL_API_KEY: "key-123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@example.com",
        HOST_EMAIL_PROVIDER: "resend",
      });
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      says(html, "Host Resend (noreply@example.com)");
      assert(!html.includes("None (disabled)"));
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
