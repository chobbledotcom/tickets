/**
 * Tests for the owner password change route
 * POST /admin/settings (current_password / new_password / new_password_confirm)
 *
 * Sits beside the story `@story:access.changing-the-owners-password`: the
 * story owns the journey through the rendered settings form, so these own
 * the branch cover and the requests only a crafted POST can make — a CSRF
 * token attack, missing fields a browser would refuse to send, a too-short
 * password the browser's own minlength rule blocks, and a corrupted data key
 * forcing the update itself to fail.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { invalidateUsersCache } from "#db/users.ts";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_ADMIN_PASSWORD } from "#test-utils/internal.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  reloginAsAdmin,
  testCookie,
} from "#test-utils/session.ts";

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
      // The browser's own minlength rule blocks this send; only a crafted
      // POST can reach the server-side length check.
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

    test("rejects mismatched passwords", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "differentpassword",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("do not match"), false);
    });

    test("clears the session and records the change in the activity log", async () => {
      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });

      // The change signs every window out: the session cookie is cleared.
      expect(response.status).toBe(302);
      expectRedirect(response, "/admin");
      expectFlash(response, expect.stringContaining("Password changed"));
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(sessionCookie).toContain("Max-Age=0");

      // Changing the password deletes existing sessions; re-authenticate
      // with the new one so the owner-key log can be read back.
      await reloginAsAdmin("newpassword123");
      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Password changed"))).toBe(
        true,
      );
    });

    test("returns error when password update fails", async () => {
      // Corrupt the wrapped_data_key so updateUserPassword fails to unwrap it
      const { getDb } = await import("#db/client.ts");
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
  });
});
