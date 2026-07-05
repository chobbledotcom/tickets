import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings: external-order)", { db: true }, () => {
  describe("POST /admin/settings/external-order", () => {
    testRequiresAuth("/admin/settings/external-order", {
      body: { external_order_enabled: "true" },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/external-order",
          {
            csrf_token: "invalid-csrf-token",
            external_order_enabled: "true",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("enables external order buttons", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/external-order",
        { external_order_enabled: "true" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("External order buttons enabled"),
      );
    });

    test("disables external order buttons", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/external-order",
        { external_order_enabled: "false" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("External order buttons disabled"),
      );
    });

    test("setting persists in the database", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      expect(settings.externalOrderEnabled).toBe(false);

      await adminFormPost("/admin/settings/external-order", {
        external_order_enabled: "true",
      });

      expect(settings.externalOrderEnabled).toBe(true);
    });

    test("advanced settings page shows the external-order toggle", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Enable external order buttons?",
        "external_order_enabled",
      );
    });
  });
});
