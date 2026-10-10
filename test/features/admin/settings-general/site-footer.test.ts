// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  expectFlash,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  describeAdminSettings,
  settingsAsStored,
} from "#test-utils/settings.ts";

// jscpd:ignore-end

describeAdminSettings(() => {
  describe("POST /admin/settings/site-footer", () => {
    testRequiresAuth("/admin/settings/site-footer", {
      body: { site_footer: "Thanks for visiting." },
      method: "POST",
    });

    test("saves the site footer", async () => {
      const { response } = await adminFormPost("/admin/settings/site-footer", {
        site_footer: "Thank you for supporting our event!",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Site footer updated"));
      await settingsAsStored();
      expect(settings.siteFooter).toBe("Thank you for supporting our event!");
    });

    test("rejects a footer exceeding max length without saving it", async () => {
      await adminFormPost("/admin/settings/site-footer", {
        site_footer: "Some footer text",
      });

      const { response } = await adminFormPost("/admin/settings/site-footer", {
        site_footer: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      );
      await settingsAsStored();
      expect(settings.siteFooter).toBe("Some footer text");
    });

    test("accepts a footer at exactly max length", async () => {
      const atLimit = "x".repeat(MAX_TEXTAREA_LENGTH);
      const { response } = await adminFormPost("/admin/settings/site-footer", {
        site_footer: atLimit,
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Site footer updated"));
      await settingsAsStored();
      expect(settings.siteFooter).toBe(atLimit);
    });

    test("clears the footer when empty", async () => {
      await adminFormPost("/admin/settings/site-footer", {
        site_footer: "Some footer text",
      });

      const { response } = await adminFormPost("/admin/settings/site-footer", {
        site_footer: "",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Site footer removed"));
      await settingsAsStored();
      expect(settings.siteFooter).toBe("");
    });

    test("settings page shows the Site footer section", async () => {
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Site footer", "Formatting help");
    });

    test("settings page shows the current footer", async () => {
      await settings.update.siteFooter("See you at the gate.");
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "See you at the gate.");
    });
  });
});
