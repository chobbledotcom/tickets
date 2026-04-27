import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  awaitTestRequest,
  describeWithEnv,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
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

    test("does not display success when form param is missing", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader(
            "Test success message",
          )}`,
        },
      );
      const html = await response.text();
      expect(html).not.toContain('class="success"');
    });

    test("displays success message on the matching form when form param is provided", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?form=settings-country&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader(
            "Country updated",
          )}`,
        },
      );
      const html = await response.text();
      expect(html).toContain('id="settings-country"');
      expect(html).toContain("Country updated");
      // The success message should be inside the form, not as a global banner
      const formMatch = html.match(/id="settings-country"[\s\S]*?<\/form>/);
      expect(formMatch).toBeDefined();
      expect(formMatch?.[0]).toContain("Country updated");
    });

    test("does not show success on non-matching forms", async () => {
      const response = await awaitTestRequest(
        `/admin/settings?form=settings-country&flash=${FLASH_TEST_ID}`,
        {
          cookie: `${await testCookie()}; ${flashCookieHeader(
            "Country updated",
          )}`,
        },
      );
      const html = await response.text();
      // The theme form should not contain the success message
      const themeFormMatch = html.match(/id="settings-theme"[\s\S]*?<\/form>/);
      expect(themeFormMatch).toBeDefined();
      expect(themeFormMatch?.[0]).not.toContain("Country updated");
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
});
