import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { getDb, insert } from "#shared/db/client.ts";
import { createSession } from "#shared/db/sessions.ts";
import { getUserByUsername, invalidateUsersCache } from "#shared/db/users.ts";
import {
  adminFormPost,
  adminGet,
  assertAdminHtmlWithCookie,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  mockFormRequest,
  mockRequest,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("role enforcement", () => {
    test("manager user cannot access settings page", async () => {
      const hash = await hashPassword("managerpass");
      const encHash = await encrypt(hash);
      await getDb().execute(
        insert("users", {
          admin_level: await encrypt("manager"),
          password_hash: encHash,
          username_hash: await encrypt("manager"),
          username_index: "manager-idx-unique",
          wrapped_data_key: (await getUserByUsername(TEST_ADMIN_USERNAME))!
            .wrapped_data_key,
        }),
      );
      invalidateUsersCache();

      await createSession(
        "manager-token",
        "manager-csrf",
        Date.now() + 3600000,
        null,
        2,
      );

      const settingsResponse = await awaitTestRequest("/admin/settings", {
        cookie: `${getSessionCookieName()}=manager-token`,
      });
      expect(settingsResponse.status).toBe(403);

      const sessionsResponse = await awaitTestRequest("/admin/sessions", {
        cookie: `${getSessionCookieName()}=manager-token`,
      });
      expect(sessionsResponse.status).toBe(403);

      const usersResponse = await awaitTestRequest("/admin/users", {
        cookie: `${getSessionCookieName()}=manager-token`,
      });
      expect(usersResponse.status).toBe(403);
    });

    test("owner user can access settings page", async () => {
      const response = await adminGet("/admin/settings");
      expect(response.status).toBe(200);
    });

    test("owner user can access sessions page", async () => {
      const response = await adminGet("/admin/sessions");
      expect(response.status).toBe(200);
    });

    test("owner user can access users page", async () => {
      const response = await adminGet("/admin/users");
      await expectHtmlResponse(response, 200, "Users", TEST_ADMIN_USERNAME);
    });

    test("manager user can access dashboard", async () => {
      const cookie = await createTestManagerSession(
        "mgr-dash-session",
        "dashmanager",
      );
      await assertAdminHtmlWithCookie("/admin/", cookie, "Listings");
    });
  });

  describe("session with deleted user", () => {
    test("session with nonexistent user_id is rejected", async () => {
      await createSession(
        "orphan-session",
        "orphan-csrf",
        Date.now() + 3600000,
        null,
        999,
      );

      const response = await awaitTestRequest("/admin/", {
        cookie: `${getSessionCookieName()}=orphan-session`,
      });
      const html = await response.text();
      expect(html).toContain("Login");
    });
  });

  describe("settings updateUserPassword failure", () => {
    test("password change returns 500 when wrapped_data_key is corrupted", async () => {
      await getDb().execute({
        args: [],
        sql: "UPDATE users SET wrapped_data_key = 'corrupted_key' WHERE id = 1",
      });
      invalidateUsersCache();

      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });
      await expectFlashRedirect(
        "/admin/settings?form=settings-password#settings-password",
        expect.stringContaining("Failed to update password"),
        false,
      )(response);
    });
  });

  describe("settings user not found", () => {
    test("password change returns 500 when user is deleted mid-request", async () => {
      await getDb().execute({
        args: [],
        sql: "DELETE FROM users WHERE id = 1",
      });
      invalidateUsersCache();

      const { response } = await adminFormPost("/admin/settings", {
        current_password: TEST_ADMIN_PASSWORD,
        new_password: "newpassword123",
        new_password_confirm: "newpassword123",
      });
      expect(response.status).toBe(302);
    });
  });

  describe("utils.ts edge cases", () => {
    test("withOwnerAuthForm returns 403 for manager role", async () => {
      const { hmacHash } = await import("#shared/crypto/hashing.ts");
      const managerIdx = await hmacHash("formmanager");
      await getDb().execute(
        insert("users", {
          admin_level: await encrypt("manager"),
          password_hash: "",
          username_hash: await encrypt("formmanager"),
          username_index: managerIdx,
          wrapped_data_key: null,
        }),
      );
      invalidateUsersCache();

      await createSession(
        "mgr-form-session",
        "mgr-form-csrf",
        Date.now() + 3600000,
        null,
        2,
      );

      const { signCsrfToken } = await import("#shared/csrf.ts");
      const signedCsrf = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            csrf_token: signedCsrf,
            current_password: "test",
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
          },
          `${getSessionCookieName()}=mgr-form-session`,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("withAuth JSON + owner role returns 403 JSON for manager", async () => {
      const cookie = await createTestManagerSession(
        "mgr-json-session",
        "jsonmanager",
      );
      const setupResponse = await handleRequest(
        mockRequest("/admin/", {
          headers: { cookie },
        }),
      );
      expect(setupResponse.status).toBe(200);

      const { withAuth } = await import("#routes/auth.ts");
      const { jsonResponse } = await import("#routes/response.ts");
      const { runWithSessionContext } = await import(
        "#shared/session-context.ts"
      );

      const response = await runWithSessionContext(async () => {
        const { signCsrfToken } = await import("#shared/csrf.ts");
        const signedCsrf = await signCsrfToken();
        return withAuth(
          mockRequest("/test", {
            headers: {
              "content-type": "application/json",
              cookie,
              "x-csrf-token": signedCsrf,
            },
            method: "POST",
          }),
          { body: "json", role: "owner" },
          () => jsonResponse({ status: "ok" }),
        );
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });
  });
});
