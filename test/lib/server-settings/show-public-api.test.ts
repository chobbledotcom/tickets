import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv(
  "server (admin settings: show-public-api)",
  { db: true },
  () => {
    afterEach(() => {
      setDemoModeForTest(false);
    });

    describe("POST /admin/settings/show-public-api", () => {
      testRequiresAuth("/admin/settings/show-public-api", {
        body: {
          show_public_api: "true",
        },
        method: "POST",
      });

      test("rejects invalid CSRF token", async () => {
        const response = await handleRequest(
          mockFormRequest(
            "/admin/settings/show-public-api",
            {
              csrf_token: "invalid-csrf-token",
              show_public_api: "true",
            },
            await testCookie(),
          ),
        );
        await expectHtmlResponse(response, 403, "Invalid CSRF token");
      });

      test("enables public API", async () => {
        const { response } = await adminFormPost(
          "/admin/settings/show-public-api",
          { show_public_api: "true" },
        );

        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Public API enabled"));
      });

      test("disables public API", async () => {
        const { response } = await adminFormPost(
          "/admin/settings/show-public-api",
          { show_public_api: "false" },
        );

        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Public API disabled"));
      });

      test("setting persists in database", async () => {
        const { settings } = await import("#shared/db/settings.ts");

        expect(settings.showPublicApi).toBe(false);

        await adminFormPost("/admin/settings/show-public-api", {
          show_public_api: "true",
        });

        expect(settings.showPublicApi).toBe(true);
      });

      test("advanced settings page displays enable public API section", async () => {
        const response = await adminGet("/admin/settings-advanced");
        await expectHtmlResponse(
          response,
          200,
          "Enable public API?",
          "show_public_api",
        );
      });
    });
  },
);
