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
  describe("POST /admin/settings/show-public-site", () => {
    testRequiresAuth("/admin/settings/show-public-site", {
      body: {
        show_public_site: "true",
      },
      method: "POST",
    });

    /** POST `show_public_site=value` with a fresh CSRF token + owner cookie. */
    const postShowPublicSite = async (value: string): Promise<Response> => {
      const csrf_token = await testCsrfToken();
      return handleRequest(
        mockFormRequest(
          "/admin/settings/show-public-site",
          { csrf_token, show_public_site: value },
          await testCookie(),
        ),
      );
    };

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
      const response = await postShowPublicSite("true");
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public site enabled"));
    });

    test("disables public site", async () => {
      const response = await postShowPublicSite("false");
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Public site disabled"));
    });

    test("setting persists in database", async () => {
      // Initially should be false
      expect(settings.showPublicSite).toBe(false);

      // Enable it
      await postShowPublicSite("true");

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
