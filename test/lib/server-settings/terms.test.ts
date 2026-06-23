import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/terms", () => {
    testRequiresAuth("/admin/settings/terms", {
      body: {
        terms_and_conditions: "You must agree to our policy.",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/terms",
          {
            csrf_token: "invalid-csrf-token",
            terms_and_conditions: "Some terms",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves terms and conditions", async () => {
      const { response } = await adminFormPost("/admin/settings/terms", {
        terms_and_conditions: "By registering you agree to our listing policy.",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions updated"),
      );
    });

    test("rejects terms exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/settings/terms", {
        terms_and_conditions: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      );
    });

    test("accepts terms at exactly max length", async () => {
      const { response } = await adminFormPost("/admin/settings/terms", {
        terms_and_conditions: "x".repeat(MAX_TEXTAREA_LENGTH),
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions updated"),
      );
    });

    test("clears terms when empty", async () => {
      // First save some terms
      await adminFormPost("/admin/settings/terms", {
        terms_and_conditions: "Some terms",
      });

      // Now clear them
      const { response } = await adminFormPost("/admin/settings/terms", {
        terms_and_conditions: "",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions removed"),
      );
    });

    test("handles missing terms field gracefully", async () => {
      const { response } = await adminFormPost("/admin/settings/terms");

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Terms and conditions removed"),
      );
    });

    test("settings page shows terms and conditions section", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Terms and Conditions",
        "terms_and_conditions",
        "Formatting help",
      );
    });

    test("settings page shows current terms when configured", async () => {
      await settings.update.terms("You must be 18 or older.");
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "You must be 18 or older.");
    });
  });

  test("logs activity when terms and conditions are updated", async () => {
    await adminFormPost("/admin/settings/terms", {
      terms_and_conditions: "New terms",
    });

    const logs = await getAllActivityLog();
    expect(
      logs.some((l) => l.message.includes("Terms and conditions updated")),
    ).toBe(true);
  });

  test("logs activity when terms and conditions are removed", async () => {
    await adminFormPost("/admin/settings/terms", {
      terms_and_conditions: "",
    });

    const logs = await getAllActivityLog();
    expect(
      logs.some((l) => l.message.includes("Terms and conditions removed")),
    ).toBe(true);
  });
});
