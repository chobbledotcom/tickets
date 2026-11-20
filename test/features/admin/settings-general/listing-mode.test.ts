import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectIncludesAll,
  redirectFormId,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";

describeAdminSettings(() => {
  describe("POST /admin/settings/listing-mode", () => {
    testRequiresAuth("/admin/settings/listing-mode", {
      body: {
        listingMode: "image",
      },
      method: "POST",
    });

    /** POST the listing-mode form with a fresh CSRF token + owner cookie. */
    const postMode = async (fields: Record<string, string>) => {
      const csrfToken = await testCsrfToken();
      return handleRequest(
        mockFormRequest(
          "/admin/settings/listing-mode",
          { csrfToken, ...fields },
          await testCookie(),
        ),
      );
    };

    test("rejects an unknown mode", async () => {
      const response = await postMode({ listingMode: "gallery" });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid listing mode selection"),
        false,
      );
      expect(settings.listingMode).toBe("text");
    });

    test("rejects a missing mode field", async () => {
      const response = await postMode({});
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid listing mode selection"),
        false,
      );
    });

    test("switches to image mode", async () => {
      const response = await postMode({ listingMode: "image" });
      expect(response.status).toBe(302);
      expectFlash(response, "Listing mode set to image");
      expect(response.headers.get("location")).toContain(
        "/admin/settings-advanced",
      );
      expect(redirectFormId(response)).toBe("settings-listing-mode");
      expect(settings.listingMode).toBe("image");
    });

    test("switches back to text mode", async () => {
      await settings.update.listingMode("image");

      const response = await postMode({ listingMode: "text" });
      expect(response.status).toBe(302);
      expectFlash(response, "Listing mode set to text");
      expect(settings.listingMode).toBe("text");
    });

    test("the settings page checks the saved mode", async () => {
      await settings.update.listingMode("image");

      const response = await adminGet("/admin/settings-advanced");
      expect(response.status).toBe(200);
      expectIncludesAll(await response.text(), [
        'name="listingMode"',
        'value="image"',
        "checked",
      ]);
    });
  });
});
