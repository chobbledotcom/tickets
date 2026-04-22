import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { settings } from "#lib/db/settings.ts";
import { setDemoModeForTest } from "#lib/demo.ts";
import { handleRequest } from "#routes";
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

  describe("POST /admin/settings/country", () => {
    testRequiresAuth("/admin/settings/country", {
      body: {
        country: "US",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "US",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves valid country", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "US",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Country set to US");
    });

    test("rejects invalid country code", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "XX",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("valid country"), false);
    });

    test("rejects empty input", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Country is required"),
        false,
      );
    });

    test("setting persists and derives phone prefix", async () => {
      // Default should be GB → "44"
      expect(settings.phonePrefix).toBe("44");

      // Update to US
      await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "US",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(settings.country).toBe("US");
      expect(settings.phonePrefix).toBe("1");
      expect(settings.currency).toBe("USD");
    });

    test("settings page displays country form", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Your Country");
    });

    test("logs activity when country is changed", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/country",
          {
            country: "FR",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message === "Country set to FR")).toBe(true);
    });
  });
});
