import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/show-public-site", () => {
    testRequiresAuth("/admin/settings/show-public-site", {
      body: {
        show_public_site: "true",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            csrf_token: "invalid-csrf-token",
            show_public_site: "true",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("enables public site", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            csrf_token: await testCsrfToken(),
            show_public_site: "true",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public site enabled"));
    });

    test("disables public site", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            csrf_token: await testCsrfToken(),
            show_public_site: "false",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public site disabled"));
    });

    test("setting persists in database", async () => {
      // Initially should be false
      expect(settings.showPublicSite).toBe(false);

      // Enable it
      await handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          {
            csrf_token: await testCsrfToken(),
            show_public_site: "true",
          },
          await testCookie(),
        ),
      );

      expect(settings.showPublicSite).toBe(true);
    });

    test("settings page displays show public site section", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Show public site?",
        "show_public_site",
      );
    });
  });
});
