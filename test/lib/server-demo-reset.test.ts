import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { listingsTable } from "#shared/db/listings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import {
  RESET_DATABASE_PHRASE,
  RESET_PHRASE_MISMATCH_ERROR,
} from "#templates/admin/database-reset.tsx";
import {
  adminGet,
  assertPublicHtml,
  createTestListing,
  describeWithEnv,
  expectDatabaseResetRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  extractCsrfToken,
  installUrlHandler,
  invalidateTestDbCache,
  mockFormRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
  withFetchMock,
} from "#test-utils";

describeWithEnv("server (demo reset)", { db: true }, () => {
  beforeEach(() => {
    setDemoModeForTest(false);
  });

  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /demo/reset", () => {
    test("returns 404 when demo mode is off", async () => {
      const response = await handleRequest(mockRequest("/demo/reset"));
      expect(response.status).toBe(404);
    });

    test("returns 404 when demo mode is off even for authenticated admin", async () => {
      const response = await adminGet("/demo/reset");
      expect(response.status).toBe(404);
    });

    test("shows reset page when demo mode is on", async () => {
      setDemoModeForTest(true);
      await assertPublicHtml(
        "/demo/reset",
        "Reset Database",
        "confirm_phrase",
        RESET_DATABASE_PHRASE,
      );
    });

    test("contains back to login link", async () => {
      setDemoModeForTest(true);
      await assertPublicHtml("/demo/reset", 'href="/admin"');
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
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });

    test("rejects invalid CSRF token in demo mode", async () => {
      setDemoModeForTest(true);
      const response = await handleRequest(
        mockFormRequest("/demo/reset", {
          confirm_phrase: RESET_DATABASE_PHRASE,
          csrf_token: "invalid-token",
        }),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });

    test("rejects wrong confirmation phrase", async () => {
      setDemoModeForTest(true);
      const response = await submitDemoResetForm({
        confirm_phrase: "wrong phrase",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(RESET_PHRASE_MISMATCH_ERROR),
        false,
      );
    });

    test("rejects empty confirmation phrase", async () => {
      setDemoModeForTest(true);
      const response = await submitDemoResetForm({ confirm_phrase: "" });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(RESET_PHRASE_MISMATCH_ERROR),
        false,
      );
    });

    test("resets database and redirects to setup in demo mode", async () => {
      setDemoModeForTest(true);
      const response = await submitDemoResetForm({
        confirm_phrase: RESET_DATABASE_PHRASE,
      });

      expectDatabaseResetRedirect(response);
      invalidateTestDbCache();
    });

    test("deletes storage files for all listings during reset", async () => {
      setDemoModeForTest(true);

      const listing = await createTestListing({ maxAttendees: 10 });
      await listingsTable.update(listing.id, {
        attachmentName: "doc.pdf",
        attachmentUrl: "reset-attachment.pdf",
        imageUrl: "reset-image.jpg",
      });

      await runWithStorageConfig(
        { zoneKey: "testkey", zoneName: "testzone" },
        () =>
          withFetchMock(async (originalFetch) => {
            const deletedUrls: string[] = [];
            installUrlHandler(originalFetch, (url) => {
              if (url.includes("storage.bunnycdn.com")) {
                deletedUrls.push(url);
                return Promise.resolve(
                  new Response(JSON.stringify({ HttpCode: 200 }), {
                    status: 200,
                  }),
                );
              }
              return null;
            });

            const response = await submitDemoResetForm({
              confirm_phrase: RESET_DATABASE_PHRASE,
            });

            expectRedirectWithFlash("/setup/", "Database reset")(response);
            expect(deletedUrls.some((u) => u.includes("reset-image.jpg"))).toBe(
              true,
            );
            expect(
              deletedUrls.some((u) => u.includes("reset-attachment.pdf")),
            ).toBe(true);
          }),
      );

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
      const response = await adminGet("/admin/settings-advanced");
      const html = await expectHtmlResponse(response, 200, "Reset Database");
      expect(html).toContain(RESET_DATABASE_PHRASE);
      expect(html).toContain("confirm_phrase");
    });

    test("demo reset page uses shared reset form", async () => {
      setDemoModeForTest(true);
      await assertPublicHtml(
        "/demo/reset",
        "Reset Database",
        RESET_DATABASE_PHRASE,
        "confirm_phrase",
      );
    });
  });
});
