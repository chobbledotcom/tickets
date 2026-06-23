import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  awaitTestRequest,
  describeWithEnv,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  setTestEnv,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/settings", () => {
    testRequiresAuth("/admin/settings");

    test("shows settings page when authenticated", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Settings", "Change Password");
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
      const response = await awaitTestRequest(
        `/admin/settings?form=settings-business-email&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader(
            "Business email updated",
          )}`,
        },
      );
      const html = await response.text();
      expect(html).toContain('id="settings-business-email"');
      expect(html).toContain("Business email updated");
      // The success message should be inside the form, not as a global banner
      const formMatch = html.match(
        /id="settings-business-email"[\s\S]*?<\/form>/,
      );
      expect(formMatch).toBeDefined();
      expect(formMatch?.[0]).toContain("Business email updated");
    });

    test("does not show success on non-matching forms", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?form=settings-business-email&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader(
            "Business email updated",
          )}`,
        },
      );
      const html = await response.text();
      // The theme form should not contain the success message
      const themeFormMatch = html.match(/id="settings-theme"[\s\S]*?<\/form>/);
      expect(themeFormMatch).toBeDefined();
      expect(themeFormMatch?.[0]).not.toContain("Business email updated");
    });

    test("does not render the country form (locale is write-once, set at /setup)", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      // Country/locale can only be set during setup, then changed by an admin
      // editing the database — there is no editor on the settings page.
      expect(html).not.toContain('id="settings-country"');
      expect(html).not.toContain("/admin/settings/country");
    });

    test("each settings form has an id attribute", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('id="settings-business-email"');
      expect(html).toContain('id="settings-payment-provider"');
      expect(html).toContain('id="settings-embed-hosts"');
      expect(html).toContain('id="settings-terms"');
      expect(html).toContain('id="settings-password"');
      expect(html).toContain('id="settings-show-public-site"');
      expect(html).toContain('id="settings-theme"');
    });

    test("shows settings sub-navigation", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('href="/admin/settings-advanced"');
      expect(html).toContain('href="/admin/backup"');
      expect(html).toContain('href="/admin/debug"');
    });
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
});
