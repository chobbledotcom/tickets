import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  expectHtmlResponse,
  redirectFormId,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie } from "#test-utils/session.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";
import {
  expectAdminPage,
  expectSettingsRefused,
  expectSettingsSaved,
  postSettingsForm,
} from "#test-utils/settings-forms.ts";

const PATH = "/admin/settings/theme";

describeAdminSettings(() => {
  describe("POST /admin/settings/theme", () => {
    testRequiresAuth(PATH, {
      body: {
        theme: "dark",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          PATH,
          { csrfToken: "invalid-csrf-token", theme: "dark" },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects invalid theme value", async () => {
      expectSettingsRefused(
        await postSettingsForm(PATH, { theme: "invalid-theme" }),
        "Invalid theme selection",
      );
    });

    test("rejects missing theme field", async () => {
      expectSettingsRefused(
        await postSettingsForm(PATH, {}),
        "Invalid theme selection",
      );
    });

    test("updates theme to dark successfully", async () => {
      const response = await postSettingsForm(PATH, { theme: "dark" });

      expectSettingsSaved(response, "Theme set to dark");
      expect(redirectFormId(response)).toBe("settings-theme");
    });

    test("updates theme to light successfully", async () => {
      expectSettingsSaved(
        await postSettingsForm(PATH, { theme: "light" }),
        "Theme set to light",
      );
    });

    test("theme setting persists in database", async () => {
      expect(settings.theme).toBe("light");

      await postSettingsForm(PATH, { theme: "dark" });

      expect(settings.theme).toBe("dark");
    });

    test("settings page displays current theme selection", async () => {
      await settings.update.theme("dark");

      await expectAdminPage("/admin/settings", ['value="dark"', "checked"]);
    });

    test("ticking the underline-links checkbox enables it", async () => {
      expect(settings.underlineLinks).toBe(false);

      const response = await postSettingsForm(PATH, {
        theme: "light",
        underlineLinks: "true",
      });

      expect(response.status).toBe(302);
      expect(settings.underlineLinks).toBe(true);
    });

    test("omitting the underline-links checkbox disables it", async () => {
      // Enable first so the submission has to turn it back off.
      await settings.update.underlineLinks(true);

      const response = await postSettingsForm(PATH, { theme: "light" });

      expect(response.status).toBe(302);
      expect(settings.underlineLinks).toBe(false);
    });

    test("settings page checks the underline-links box when enabled", async () => {
      await settings.update.underlineLinks(true);

      const response = await adminGet("/admin/settings");
      const html = await response.text();
      const checkboxMatch = html.match(
        /<input[^>]*name="underlineLinks"[^>]*>/,
      );
      assertStringIncludes(checkboxMatch?.[0] ?? "", "checked");
    });
  });
});
