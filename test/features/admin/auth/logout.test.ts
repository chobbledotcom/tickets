import { assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { createTestAgentSession, loginAsAdmin } from "#test-utils/session.ts";

describeWithEnv("server (admin logout)", { db: true }, () => {
  describe("POST /admin/logout", () => {
    testRequiresAuth("/admin/logout", {
      body: { csrfToken: "invalid" },
      method: "POST",
    });

    test("rejects invalid CSRF token when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest("/admin/logout", { csrfToken: "invalid-csrf" }, cookie),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("succeeds with valid CSRF token", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest("/admin/logout", { csrfToken }, cookie),
      );
      await expectFlashRedirect("/admin", "Logged out")(response);
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      assertStringIncludes(sessionCookie ?? "", "Max-Age=0");
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
});
