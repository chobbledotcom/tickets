// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  awaitTestRequest,
  describeAdminSettings,
  expectFlash,
  expectHtmlResponse,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end

describeAdminSettings(() => {
  describe("POST /admin/settings/theme", () => {
    testRequiresAuth("/admin/settings/theme", {
      body: {
        theme: "dark",
      },
      method: "POST",
    });

    /** POST a theme form with a fresh CSRF token + owner cookie. `fields` can
     *  omit `theme` to exercise the missing-field path. */
    const postTheme = async (
      fields: Record<string, string>,
    ): Promise<Response> => {
      const csrf_token = await testCsrfToken();
      return handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          { csrf_token, ...fields },
          await testCookie(),
        ),
      );
    };

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/theme",
          { csrf_token: "invalid-csrf-token", theme: "dark" },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects invalid theme value", async () => {
      const response = await postTheme({ theme: "invalid-theme" });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid theme selection"),
        false,
      );
    });

    test("rejects missing theme field", async () => {
      const response = await postTheme({});
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid theme selection"),
        false,
      );
    });

    test("updates theme to dark successfully", async () => {
      const response = await postTheme({ theme: "dark" });
      expect(response.status).toBe(302);
      expectFlash(response, "Theme set to dark");
    });

    test("updates theme to light successfully", async () => {
      const response = await postTheme({ theme: "light" });
      expect(response.status).toBe(302);
      expectFlash(response, "Theme set to light");
    });

    test("theme setting persists in database", async () => {
      // Initially should be "light"
      expect(settings.theme).toBe("light");

      // Update to dark
      await postTheme({ theme: "dark" });

      // Should now be "dark"
      expect(settings.theme).toBe("dark");
    });

    test("settings page displays current theme selection", async () => {
      // Set theme to dark
      await settings.update.theme("dark");

      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      // Check that dark radio button is checked
      expect(html).toContain('value="dark"');
      expect(html).toContain("checked");
    });

    test("ticking the underline-links checkbox enables it", async () => {
      expect(settings.underlineLinks).toBe(false);

      const response = await postTheme({
        theme: "light",
        underline_links: "true",
      });

      expect(response.status).toBe(302);
      expect(settings.underlineLinks).toBe(true);
    });

    test("omitting the underline-links checkbox disables it", async () => {
      // Enable first so the submission has to turn it back off.
      await settings.update.underlineLinks(true);

      const response = await postTheme({ theme: "light" });

      expect(response.status).toBe(302);
      expect(settings.underlineLinks).toBe(false);
    });

    test("settings page checks the underline-links box when enabled", async () => {
      await settings.update.underlineLinks(true);

      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      const checkboxMatch = html.match(
        /<input[^>]*name="underline_links"[^>]*>/,
      );
      expect(checkboxMatch?.[0]).toContain("checked");
    });
  });
});
