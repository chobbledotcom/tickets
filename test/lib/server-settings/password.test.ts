import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  getAllActivityLog,
  mockAdminLoginRequest,
  mockFormRequest,
  reloginAsAdmin,
  TEST_ADMIN_PASSWORD,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings", () => {
    testRequiresAuth("/admin/settings", {
      body: {
        current_password: "test",
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            csrf_token: "invalid-csrf-token",
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing required fields", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: "",
        new_password: "",
        new_password_confirm: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("rejects password shorter than 8 characters", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "short",
        new_password_confirm: "short",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("at least 8 characters"),
        false,
      );
    });

    test("rejects mismatched passwords", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "differentpassword",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("do not match"), false);
    });

    test("rejects incorrect current password", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: "wrongpassword",
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Current password is incorrect"),
        false,
      );
    });

    test("changes password and invalidates session", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });

      // Should redirect to admin login with success message and session cleared
      expect(response.status).toBe(302);
      expectRedirect(response, "/admin");
      expectFlash(response, expect.stringContaining("Password changed"));
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(sessionCookie).toContain("Max-Age=0");

      // Verify old session is invalidated
      const dashboardResponse = await awaitTestRequest("/admin/", {
        cookie: await testCookie(),
      });
      const html = await dashboardResponse.text();
      expect(html).toContain("Login"); // Should show login, not dashboard

      // Verify new password works
      const newLoginResponse = await handleRequest(
        await mockAdminLoginRequest({
          password: "newpassword123",
          username: "testadmin",
        }),
      );
      expectRedirectWithFlash("/admin", "Logged in")(newLoginResponse);
    });

    test("returns error when password update fails", async () => {
      // Corrupt the wrapped_data_key so updateUserPassword fails to unwrap it
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute({
        args: ["corrupted-key-data"],
        sql: "UPDATE users SET wrapped_data_key = ?",
      });
      invalidateUsersCache();

      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Failed to update password"),
        false,
      );
    });

    test("logs activity when password is changed", async () => {
      await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });

      // Changing the password deletes existing sessions; re-authenticate with
      // the new password so the owner-key log can be read back.
      await reloginAsAdmin("newpassword123");
      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Password changed"))).toBe(
        true,
      );
    });
  });
});
