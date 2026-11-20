import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { redirectFormId, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";
import {
  expectAdminPage,
  expectSettingsRefused,
  expectSettingsSaved,
  postSettingsForm,
} from "#test-utils/settings-forms.ts";

const PATH = "/admin/settings/listing-mode";

describeAdminSettings(() => {
  describe("POST /admin/settings/listing-mode", () => {
    testRequiresAuth(PATH, {
      body: {
        listingMode: "image",
      },
      method: "POST",
    });

    test("rejects an unknown mode", async () => {
      const response = await postSettingsForm(PATH, { listingMode: "gallery" });

      expectSettingsRefused(response, "Invalid listing mode selection");
      expect(settings.listingMode).toBe("text");
    });

    test("rejects a missing mode field", async () => {
      expectSettingsRefused(
        await postSettingsForm(PATH, {}),
        "Invalid listing mode selection",
      );
    });

    test("switches to image mode", async () => {
      const response = await postSettingsForm(PATH, { listingMode: "image" });

      expectSettingsSaved(response, "Listing mode set to image");
      expect(response.headers.get("location")).toContain(
        "/admin/settings-advanced",
      );
      expect(redirectFormId(response)).toBe("settings-listing-mode");
      expect(settings.listingMode).toBe("image");
    });

    test("switches back to text mode", async () => {
      await settings.update.listingMode("image");

      const response = await postSettingsForm(PATH, { listingMode: "text" });

      expectSettingsSaved(response, "Listing mode set to text");
      expect(settings.listingMode).toBe("text");
    });

    test("the settings page checks the saved mode", async () => {
      await settings.update.listingMode("image");

      await expectAdminPage("/admin/settings-advanced", [
        'name="listingMode"',
        'value="image"',
        "checked",
      ]);
    });
  });
});
