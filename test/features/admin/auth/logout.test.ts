import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { getSession } from "#shared/db/sessions.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { createTestAgentSession, loginAsAdmin } from "#test-utils/session.ts";

describeWithEnv("server (admin logout)", { db: true }, () => {
  describe("POST /admin/logout", () => {
    testRequiresAuth("/admin/logout", {
      body: { csrf_token: "invalid" },
      method: "POST",
    });

    test("rejects invalid CSRF token when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/logout",
          { csrf_token: "invalid-csrf" },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("succeeds with valid CSRF token", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest("/admin/logout", { csrf_token: csrfToken }, cookie),
      );
      await expectFlashRedirect("/admin", "Logged out")(response);
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(sessionCookie).toContain("Max-Age=0");
    });
  });

  describe("GET /admin/logout", () => {
    testRequiresAuth("/admin/logout");

    test("shows confirmation page with the actual POST form", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockRequest("/admin/logout", { headers: { cookie } }),
      );

      await expectHtmlResponse(
        response,
        200,
        "Are you sure you want to log out?",
        'action="/admin/logout"',
        'method="POST"',
      );
    });

    test("shows confirmation page to delivery agents", async () => {
      const { cookie } = await createTestAgentSession();

      const response = await handleRequest(
        mockRequest("/admin/logout", { headers: { cookie } }),
      );

      await expectHtmlResponse(
        response,
        200,
        "Are you sure you want to log out?",
        'action="/admin/logout"',
        'method="POST"',
      );
    });
  });
  describe("logout with valid session", () => {
    test("deletes session from database", async () => {
      // Log in first
      const { cookie, csrfToken } = await loginAsAdmin();
      const token = cookie.split("=")[1]?.split(";")[0] || "";

      expect(token).not.toBe("");
      const sessionBefore = await getSession(token);
      expect(sessionBefore).not.toBeNull();

      // Now logout
      const logoutResponse = await awaitTestRequest("/admin/logout", {
        cookie,
        data: { csrf_token: csrfToken },
      });
      expect(logoutResponse.status).toBe(302);

      // Verify session was deleted
      const sessionAfter = await getSession(token);
      expect(sessionAfter).toBeNull();
    });
  });
});
