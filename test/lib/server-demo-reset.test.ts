import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { setDemoModeForTest } from "#lib/demo.ts";
import { handleRequest } from "#routes";
import {
  RESET_DATABASE_PHRASE,
  RESET_PHRASE_MISMATCH_ERROR,
} from "#templates/admin/database-reset.tsx";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectHtmlResponse,
  expectRedirect,
  extractCsrfToken,
  invalidateTestDbCache,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  testCookie,
  testCsrfToken,
} from "#test-utils";

describe("server (demo reset)", () => {
  beforeEach(async () => {
    setDemoModeForTest(false);
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    setDemoModeForTest(false);
    resetDb();
  });

  describe("GET /demo/reset", () => {
    test("returns 404 when demo mode is off", async () => {
      const response = await handleRequest(mockRequest("/demo/reset"));
      expect(response.status).toBe(404);
    });

    test("returns 404 when demo mode is off even for authenticated admin", async () => {
      const response = await awaitTestRequest("/demo/reset", {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("shows reset page when demo mode is on", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(mockRequest("/demo/reset"));
      const html = await expectHtmlResponse(response, 200, "Reset Database");
      expect(html).toContain("confirm_phrase");
      expect(html).toContain(RESET_DATABASE_PHRASE);
    });

    test("contains back to login link", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(mockRequest("/demo/reset"));
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain('href="/admin"');
    });
  });

  /** Get CSRF token from demo reset page and post form with given fields */
  async function submitDemoResetForm(
    fields: Record<string, string>,
  ): Promise<Response> {
    const getResponse = await handleRequest(mockRequest("/demo/reset"));
    const html = await getResponse.text();
    const csrfToken = extractCsrfToken(html)!;
    return handleRequest(
      mockFormRequest("/demo/reset", { ...fields, csrf_token: csrfToken }),
    );
  }

  describe("POST /demo/reset", () => {
    test("returns 404 when demo mode is off", async () => {
      const response = await handleRequest(
        mockFormRequest("/demo/reset", {
          confirm_phrase: RESET_DATABASE_PHRASE,
        }),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when demo mode is off even for authenticated admin", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/demo/reset",
          {
            confirm_phrase: RESET_DATABASE_PHRASE,
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects missing CSRF token in demo mode", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(
        mockFormRequest("/demo/reset", {
          confirm_phrase: RESET_DATABASE_PHRASE,
        }),
      );
      await expectHtmlResponse(response, 403, "Invalid or expired form");
    });

    test("rejects invalid CSRF token in demo mode", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(
        mockFormRequest("/demo/reset", {
          confirm_phrase: RESET_DATABASE_PHRASE,
          csrf_token: "invalid-token",
        }),
      );
      await expectHtmlResponse(response, 403, "Invalid or expired form");
    });

    test("rejects wrong confirmation phrase", async () => {
      setDemoModeForTest(true);
      const response = await submitDemoResetForm({
        confirm_phrase: "wrong phrase",
      });
      await expectHtmlResponse(response, 400, RESET_PHRASE_MISMATCH_ERROR);
    });

    test("rejects empty confirmation phrase", async () => {
      setDemoModeForTest(true);
      const response = await submitDemoResetForm({ confirm_phrase: "" });
      await expectHtmlResponse(response, 400, RESET_PHRASE_MISMATCH_ERROR);
    });

    test("resets database and redirects to setup in demo mode", async () => {
      setDemoModeForTest(true);
      const response = await submitDemoResetForm({
        confirm_phrase: RESET_DATABASE_PHRASE,
      });

      expectRedirect("/setup/?success=Database+reset")(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      invalidateTestDbCache();
    });
  });

  describe("login page demo reset link", () => {
    test("does not show reset link when demo mode is off", async () => {
      const response = await handleRequest(mockRequest("/admin/login"));
      const html = await response.text();
      expect(html).not.toContain("/demo/reset");
    });

    test("shows reset link when demo mode is on", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(mockRequest("/admin/login"));
      const html = await response.text();
      expect(html).toContain('href="/demo/reset"');
      expect(html).toContain("Reset database");
    });
  });

  describe("shared form component", () => {
    test("admin settings page uses shared reset form", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(response, 200, "Reset Database");
      expect(html).toContain(RESET_DATABASE_PHRASE);
      expect(html).toContain("confirm_phrase");
    });

    test("demo reset page uses shared reset form", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(mockRequest("/demo/reset"));
      const html = await expectHtmlResponse(response, 200, "Reset Database");
      expect(html).toContain(RESET_DATABASE_PHRASE);
      expect(html).toContain("confirm_phrase");
    });
  });
});
