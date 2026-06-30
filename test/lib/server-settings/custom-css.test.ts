// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  adminFormPost,
  adminGet,
  describeAdminSettings,
  expectFlash,
  expectHtmlResponse,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end

describeAdminSettings(() => {
  describe("POST /admin/settings/custom-css", () => {
    testRequiresAuth("/admin/settings/custom-css", {
      body: {
        custom_css: "body { color: red; }",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/custom-css",
          {
            csrf_token: "invalid-csrf-token",
            custom_css: "body { color: red; }",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves custom CSS", async () => {
      const { response } = await adminFormPost("/admin/settings/custom-css", {
        custom_css: "body { color: red; }",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Custom CSS updated"));
      expect(settings.customCss).toBe("body { color: red; }");
    });

    test("rejects CSS exceeding max length without saving it", async () => {
      const tooLong = "a".repeat(MAX_TEXTAREA_LENGTH + 1);
      const { response } = await adminFormPost("/admin/settings/custom-css", {
        custom_css: tooLong,
      });

      expect(response.status).toBe(302);
      expect(settings.customCss).toBe("");
      expectFlash(
        response,
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      );
    });

    test("clears custom CSS when empty", async () => {
      await adminFormPost("/admin/settings/custom-css", {
        custom_css: "body { color: red; }",
      });

      const { response } = await adminFormPost("/admin/settings/custom-css", {
        custom_css: "",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Custom CSS removed"));
      expect(settings.customCss).toBe("");
    });

    test("advanced settings page shows the custom CSS section", async () => {
      const response = await adminGet("/admin/settings-advanced");
      await expectHtmlResponse(response, 200, "Custom CSS", "custom_css");
    });

    test("logs activity when custom CSS is updated", async () => {
      await adminFormPost("/admin/settings/custom-css", {
        custom_css: "a { text-decoration: none; }",
      });

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Custom CSS updated"))).toBe(
        true,
      );
    });
  });
});
