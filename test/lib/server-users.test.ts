import { getSessionCookieName } from "#lib/cookies.ts";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { getDb } from "#lib/db/client.ts";
import { createSession } from "#lib/db/sessions.ts";
import {
  createInvitedUser,
  decryptAdminLevel,
  decryptUsername,
  flagExpiredInvite,
  flagExpiredInvites,
  getAllUsers,
  getUserById,
  getUserByUsername,
  hasPassword,
  invalidateUsersCache,
  isInviteValid,
  verifyUserPassword,
} from "#lib/db/users.ts";
import { encrypt, hashPassword } from "#lib/crypto.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  createTestInvite,
  createTestManagerSession,
  expectAdminRedirect,
  expectHtmlResponse,
  expectRedirect,
  loginAsAdmin,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  submitJoinForm,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

describe("server (multi-user admin)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("users CRUD", () => {
    test("createTestDbWithSetup creates the owner user", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(1);
      expect(user!.wrapped_data_key).not.toBeNull();

      const level = await decryptAdminLevel(user!);
      expect(level).toBe("owner");

      const username = await decryptUsername(user!);
      expect(username).toBe(TEST_ADMIN_USERNAME);
    });

    test("verifyUserPassword returns hash for correct password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const hash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(hash).toBeTruthy();
      expect(hash).toContain("pbkdf2:");
    });

    test("verifyUserPassword returns null for wrong password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const result = await verifyUserPassword(user!, "wrongpassword");
      expect(result).toBeNull();
    });

    test("getUserByUsername returns null for nonexistent user", async () => {
      const user = await getUserByUsername("nonexistent");
      expect(user).toBeNull();
    });

    test("getAllUsers returns all users", async () => {
      const users = await getAllUsers();
      expect(users.length).toBe(1);
      expect(users[0]!.id).toBe(1);
    });
  });

  describe("invited users", () => {
    test("createInvitedUser creates user with invite code", async () => {
      const inviteHash = await hashPassword("invite123");
      const expiry = new Date(Date.now() + 86400000).toISOString();

      const user = await createInvitedUser(
        "invitee",
        "manager",
        inviteHash,
        expiry,
      );

      expect(user.id).toBe(2);
      expect(user.password_hash).toBe("");
      expect(user.wrapped_data_key).toBeNull();

      const level = await decryptAdminLevel(user);
      expect(level).toBe("manager");

      const username = await decryptUsername(user);
      expect(username).toBe("invitee");

      const hasPwd = await hasPassword(user);
      expect(hasPwd).toBe(false);
    });

    test("isInviteValid returns true for valid invite", async () => {
      const expiry = new Date(Date.now() + 86400000).toISOString();
      const user = await createInvitedUser(
        "invitee",
        "manager",
        "somehash",
        expiry,
      );

      const valid = await isInviteValid(user);
      expect(valid).toBe(true);
    });

    test("isInviteValid returns false for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const user = await createInvitedUser(
        "expired-user",
        "manager",
        "somehash",
        expiry,
      );

      const valid = await isInviteValid(user);
      expect(valid).toBe(false);
    });
  });

  describe("flagging expired invites", () => {
    test("flagExpiredInvite sets invite_expired to 1", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const user = await createInvitedUser("flag-test", "manager", "somehash", expiry);
      expect(user.invite_expired).toBe(0);

      await flagExpiredInvite(user.id);

      const updated = await getUserById(user.id);
      expect(updated!.invite_expired).toBe(1);
    });

    test("flagExpiredInvites flags all expired invites", async () => {
      const expired = new Date(Date.now() - 1000).toISOString();
      const valid = new Date(Date.now() + 86400000).toISOString();
      await createInvitedUser("expired-bulk", "manager", "hash1", expired);
      await createInvitedUser("valid-bulk", "manager", "hash2", valid);

      await flagExpiredInvites();

      const expiredUser = await getUserByUsername("expired-bulk");
      expect(expiredUser!.invite_expired).toBe(1);
      const validUser = await getUserByUsername("valid-bulk");
      expect(validUser!.invite_expired).toBe(0);
    });

    test("flagExpiredInvites skips already flagged users", async () => {
      const expired = new Date(Date.now() - 1000).toISOString();
      const user = await createInvitedUser("already-flagged", "manager", "hash3", expired);
      await flagExpiredInvite(user.id);

      // Should not error when running again
      await flagExpiredInvites();

      const updated = await getUserById(user.id);
      expect(updated!.invite_expired).toBe(1);
    });
  });

  describe("role enforcement", () => {
    test("manager user cannot access settings page", async () => {
      // Create a manager user with a password
      const hash = await hashPassword("managerpass");
      const encHash = await encrypt(hash);
      await getDb().execute({
        sql:
          `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          await encrypt("manager"),
          "manager-idx-unique",
          encHash,
          // Give the manager a wrapped_data_key so login works
          (await getUserByUsername(TEST_ADMIN_USERNAME))!.wrapped_data_key,
          await encrypt("manager"),
        ],
      });
      invalidateUsersCache();

      // Create a session for the manager user
      const managerUserId = 2;
      await createSession(
        "manager-token",
        "manager-csrf",
        Date.now() + 3600000,
        null,
        managerUserId,
      );

      // Manager should get 403 on owner-only routes
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
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
    });

    test("owner user can access sessions page", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/sessions", { cookie });
      expect(response.status).toBe(200);
    });

    test("owner user can access users page", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/users", { cookie });
      await expectHtmlResponse(response, 200, "Users", TEST_ADMIN_USERNAME);
    });

    test("manager user can access dashboard", async () => {
      const cookie = await createTestManagerSession(
        "mgr-dash-session",
        "dashmanager",
      );
      const response = await awaitTestRequest("/admin/", { cookie });
      await expectHtmlResponse(response, 200, "Events");
    });
  });

  describe("GET /admin/users", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/users"));
      expectAdminRedirect(response);
    });

    test("shows users list when authenticated as owner", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/users", { cookie });
      await expectHtmlResponse(response, 200, TEST_ADMIN_USERNAME, "owner");
    });
  });

  describe("GET /admin/users (with query params)", () => {
    test("displays invite link from query param", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(
        "/admin/users?invite=" +
          encodeURIComponent("https://localhost/join/abc123"),
        { cookie },
      );
      await expectHtmlResponse(
        response,
        200,
        "https://localhost/join/abc123",
        "Invite link",
      );
    });

    test("displays success message from query param", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(
        "/admin/users?success=User+deleted+successfully",
        { cookie },
      );
      await expectHtmlResponse(
        response,
        200,
        "User deleted successfully",
        'class="success"',
      );
    });
  });

  describe("GET /admin/user/new", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/user/new"));
      expectAdminRedirect(response);
    });

    test("renders invite user form when authenticated as owner", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/user/new", { cookie });
      await expectHtmlResponse(
        response,
        200,
        "Invite User",
        'action="/admin/users"',
      );
    });
  });

  describe("POST /admin/users (invite)", () => {
    test("redirects when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/users", {
          username: "newuser",
          admin_level: "manager",
        }),
      );
      expectAdminRedirect(response);
    });

    test("creates invited user and shows invite link", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "newmanager",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("/join/");

      // Verify user was created in the database
      const users = await getAllUsers();
      expect(users.length).toBe(2);
    });

    test("rejects duplicate username", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: TEST_ADMIN_USERNAME,
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "already taken");
    });

    test("rejects invalid role", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "newuser",
            admin_level: "superadmin",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await expectHtmlResponse(response, 400, "Invalid role");
    });
  });

  describe("POST /admin/users/:id/delete", () => {
    test("deletes a user", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create an invited user first
      await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "deleteme",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const usersBefore = await getAllUsers();
      expect(usersBefore.length).toBe(2);

      // Delete user with id 2
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/2/delete",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("deleted");

      const usersAfter = await getAllUsers();
      expect(usersAfter.length).toBe(1);
    });

    test("prevents deleting self", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/1/delete",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 400, "Cannot delete your own account");
    });
  });

  describe("login flow", () => {
    test("login with username and password", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          username: TEST_ADMIN_USERNAME,
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      expect(response.headers.get("set-cookie")).toContain(
        `${getSessionCookieName()}=`,
      );
    });

    test("login with wrong username returns 401", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          username: "nonexistent",
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      expect(response.status).toBe(401);
    });

    test("login with wrong password returns 401", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          username: TEST_ADMIN_USERNAME,
          password: "wrongpassword",
        }),
      );
      expect(response.status).toBe(401);
    });

    test("login page shows username field", async () => {
      const response = await handleRequest(mockRequest("/admin/"));
      await expectHtmlResponse(response, 200, "username");
    });
  });

  describe("join flow", () => {
    test("GET /join/:code returns 404 for invalid code", async () => {
      const response = await handleRequest(mockRequest("/join/invalidcode123"));
      await expectHtmlResponse(response, 404, "invalid");
    });

    test("GET /join/:code returns join page for valid invite", async () => {
      const { inviteCode } = await createTestInvite("joiner");

      const joinResponse = await handleRequest(
        mockRequest(`/join/${inviteCode}`),
      );
      expect(joinResponse.status).toBe(200);
      const joinHtml = await joinResponse.text();
      expect(joinHtml).toContain("joiner");
      expect(joinHtml).toContain("password");
    });

    test("GET /join/complete shows confirmation page", async () => {
      const response = await handleRequest(mockRequest("/join/complete"));
      await expectHtmlResponse(response, 200, "Password Set");
    });

    test("POST /join/:code sets password for invited user", async () => {
      const { inviteCode } = await createTestInvite("joiner2");

      const joinPostResponse = await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });

      expectRedirect("/join/complete")(joinPostResponse);

      // Verify user now has a password
      const user = await getUserByUsername("joiner2");
      expect(user).not.toBeNull();
      const hasPwd = await hasPassword(user!);
      expect(hasPwd).toBe(true);
    });

    test("POST /join/:code rejects mismatched passwords", async () => {
      const { inviteCode } = await createTestInvite("joiner3");

      const joinPostResponse = await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "differentpassword",
      });

      expect(joinPostResponse.status).toBe(400);
      const html = await joinPostResponse.text();
      expect(html).toContain("do not match");
    });

    test("POST /join/:code rejects short passwords", async () => {
      const { inviteCode } = await createTestInvite("joiner4");

      const joinPostResponse = await submitJoinForm(inviteCode, {
        password: "short",
        password_confirm: "short",
      });

      expect(joinPostResponse.status).toBe(400);
      const html = await joinPostResponse.text();
      expect(html).toContain("8 characters");
    });
  });

  describe("navigation", () => {
    test("owner sees all nav links", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/", { cookie });
      const html = await response.text();
      expect(html).toContain("Settings");
      expect(html).toContain("Sessions");
      expect(html).toContain("Users");
    });

    test("manager does not see owner-only nav links", async () => {
      const cookie = await createTestManagerSession(
        "navmgr-session",
        "navmanager",
      );
      const dashboardResponse = await awaitTestRequest("/admin/", { cookie });
      const html = await dashboardResponse.text();
      expect(html).not.toContain("Settings");
      expect(html).not.toContain("Sessions");
      expect(html).not.toContain("Users");
    });
  });

  describe("setup page", () => {
    test("setup includes admin_username field", async () => {
      // Need to start fresh without setup
      const { getDb: getDbFn } = await import("#lib/db/client.ts");
      await getDbFn().execute("DELETE FROM settings");
      await getDbFn().execute("DELETE FROM users");
      const {
        clearSetupCompleteCache,
        invalidateSettingsCache: invalidateCache,
      } = await import("#lib/db/settings.ts");
      clearSetupCompleteCache();
      invalidateCache();
      invalidateUsersCache();

      const response = await handleRequest(mockRequest("/setup/"));
      await expectHtmlResponse(response, 200, "admin_username");
    });
  });

  describe("POST /admin/users/:id/activate", () => {
    test("activates user who has set password", async () => {
      const { inviteCode, cookie, csrfToken } = await createTestInvite(
        "activateme",
      );

      await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });

      // Now activate user id 2
      const activateResponse = await handleRequest(
        mockFormRequest(
          "/admin/users/2/activate",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(activateResponse.status).toBe(302);
      const location = activateResponse.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("activated successfully");
    });

    test("returns 404 for nonexistent user", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/999/activate",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 404, "User not found");
    });

    test("rejects user who has not set password", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create invite but don't complete join flow
      await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "nopassword",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/2/activate",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 400, "not set their password");
    });

    test("rejects already activated user", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // User 1 (the owner) is already activated
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/1/activate",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 400, "already activated");
    });

    test("returns 500 when session lacks data key", async () => {
      // Create a session without wrapped_data_key for the owner
      await createSession(
        "no-dk-session",
        "no-dk-csrf",
        Date.now() + 3600000,
        null,
        1,
      );

      // Create an invited user with password set
      const { inviteCode } = await createTestInvite("needsactivation");
      await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });

      // Try to activate using session without data key (need a signed CSRF token)
      const { signCsrfToken } = await import("#lib/csrf.ts");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/2/activate",
          { csrf_token: csrfToken },
          `${getSessionCookieName()}=no-dk-session`,
        ),
      );
      await expectHtmlResponse(response, 500, "session lacks data key");
    });
  });

  describe("POST /admin/users/:id/delete (not found)", () => {
    test("returns 404 for nonexistent user", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/999/delete",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 404, "User not found");
    });
  });

  describe("POST /admin/users (form validation)", () => {
    test("rejects missing username", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("join flow (expired invite)", () => {
    test("GET /join/:code returns 410 for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const { hashInviteCode } = await import("#lib/db/users.ts");
      const codeHash = await hashInviteCode("expired-code-123");
      await createInvitedUser("expired-join", "manager", codeHash, expiry);

      const response = await handleRequest(
        mockRequest("/join/expired-code-123"),
      );
      await expectHtmlResponse(response, 410, "expired");
    });

    test("GET /join/:code flags expired invite on users table", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const { hashInviteCode } = await import("#lib/db/users.ts");
      const codeHash = await hashInviteCode("expired-flag-123");
      const user = await createInvitedUser("expired-flag-user", "manager", codeHash, expiry);
      expect(user.invite_expired).toBe(0);

      await handleRequest(mockRequest("/join/expired-flag-123"));

      const updated = await getUserById(user.id);
      expect(updated!.invite_expired).toBe(1);
    });

    test("POST /join/:code returns 410 for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const { hashInviteCode } = await import("#lib/db/users.ts");
      const codeHash = await hashInviteCode("expired-post-123");
      await createInvitedUser("expired-post-user", "manager", codeHash, expiry);

      const response = await handleRequest(
        mockFormRequest(
          "/join/expired-post-123",
          {
            password: "pass12345678",
            password_confirm: "pass12345678",
            csrf_token: "fake",
          },
        ),
      );
      expect(response.status).toBe(410);
    });
  });

  describe("join flow (CSRF validation)", () => {
    test("POST /join/:code rejects invalid CSRF token", async () => {
      const { inviteCode } = await createTestInvite("csrf-test-user");

      // POST with invalid (unsigned) CSRF token
      const response = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          {
            password: "newpassword123",
            password_confirm: "newpassword123",
            csrf_token: "wrong",
          },
        ),
      );
      await expectHtmlResponse(response, 403, "try again");
    });

    test("POST /join/:code rejects missing CSRF token", async () => {
      const { inviteCode } = await createTestInvite("csrf-missing-user");

      // POST with fake CSRF token (not properly signed)
      const response = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          {
            password: "newpassword123",
            password_confirm: "newpassword123",
            csrf_token: "token",
          },
        ),
      );
      expect(response.status).toBe(403);
    });

    test("POST /join/:code rejects form without csrf_token field", async () => {
      const { inviteCode } = await createTestInvite("csrf-nofield-user");

      // POST without csrf_token field in form
      const body = "password=newpassword123&password_confirm=newpassword123";
      const response = await handleRequest(
        new Request(`http://localhost/join/${inviteCode}`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        }),
      );
      expect(response.status).toBe(403);
    });

    test("POST /join/:code rejects missing password fields", async () => {
      const { inviteCode } = await createTestInvite("validation-user");

      const response = await submitJoinForm(inviteCode, {
        password: "",
        password_confirm: "",
      });
      expect(response.status).toBe(400);
    });
  });

  describe("users template rendering", () => {
    test("shows Invited status for user without password", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      // Create invited user (no password yet)
      await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "invited-only",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const response = await awaitTestRequest("/admin/users", { cookie });
      const html = await response.text();
      expect(html).toContain("Invited");
    });

    test("shows Invite Expired status for expired invite", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      // Create an invited user then manually expire it
      await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "expired-display",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Set invite_expiry to past and let flagExpiredInvites detect it
      const expiredExpiry = await encrypt(new Date(Date.now() - 1000).toISOString());
      await getDb().execute({
        sql: "UPDATE users SET invite_expiry = ? WHERE id = 2",
        args: [expiredExpiry],
      });
      invalidateUsersCache();

      const response = await awaitTestRequest("/admin/users", { cookie });
      const html = await response.text();
      expect(html).toContain("Invite Expired");
    });

    test("shows Pending Activation status and Activate button for user with password but no data key", async () => {
      const { inviteCode, cookie } = await createTestInvite("pending-user");

      await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });

      // Users page should show "Pending Activation" and "Activate" button
      const usersResponse = await awaitTestRequest("/admin/users", { cookie });
      const html = await usersResponse.text();
      expect(html).toContain("Pending Activation");
      expect(html).toContain("Activate");
    });
  });

  describe("db/users.ts edge cases", () => {
    test("verifyUserPassword returns null when user has empty password_hash", async () => {
      const user = await createInvitedUser(
        "nopwd",
        "manager",
        "hash",
        new Date(Date.now() + 86400000).toISOString(),
      );
      const result = await verifyUserPassword(user, "anypassword");
      expect(result).toBeNull();
    });

    test("isInviteValid returns false when invite_code_hash is null", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      // The owner user has no invite_code_hash
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite was already used (empty decrypted hash)", async () => {
      const { setUserPassword: setUserPwd } = await import("#lib/db/users.ts");
      const expiry = new Date(Date.now() + 86400000).toISOString();
      const user = await createInvitedUser(
        "used-invite",
        "manager",
        "somehash",
        expiry,
      );

      // Setting password clears invite_code_hash (sets to encrypted "")
      await setUserPwd(user.id, "newpassword123");

      // Reload user
      const { getUserById: getUser } = await import("#lib/db/users.ts");
      const updatedUser = await getUser(user.id);
      const valid = await isInviteValid(updatedUser!);
      expect(valid).toBe(false);
    });

    test("hasPassword returns false for user with empty encrypted password", async () => {
      const user = await createInvitedUser(
        "nopwd2",
        "manager",
        "hash2",
        new Date(Date.now() + 86400000).toISOString(),
      );
      // User was created with empty password_hash - the createInvitedUser passes ""
      const hasPwd = await hasPassword(user);
      expect(hasPwd).toBe(false);
    });

    test("isInviteValid returns false when invite_expiry is null", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("no-expiry-user");
      await getDb().execute({
        sql:
          `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("no-expiry-user"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt("somehash"),
          null,
        ],
      });
      invalidateUsersCache();

      const user = await getUserByUsername("no-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("decryptAdminLevel throws when admin_level decrypts to invalid value", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("badlevel-user");
      await getDb().execute({
        sql:
          `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("badlevel-user"),
          usernameIdx,
          "",
          null,
          await encrypt("superadmin"),
          null,
          null,
        ],
      });
      invalidateUsersCache();

      const user = await getUserByUsername("badlevel-user");
      await expect(decryptAdminLevel(user!)).rejects.toThrow(
        "Invalid admin level",
      );
    });

    test("isInviteValid returns false when invite_expiry decrypts to empty string", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("empty-expiry-user");
      await getDb().execute({
        sql:
          `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("empty-expiry-user"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt("somehash"),
          await encrypt(""),
        ],
      });
      invalidateUsersCache();

      const user = await getUserByUsername("empty-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });
  });

  describe("utils.ts edge cases", () => {
    test("withOwnerAuthForm returns 403 for manager role", async () => {
      // Create manager user
      const { hmacHash } = await import("#lib/crypto.ts");
      const managerIdx = await hmacHash("formmanager");
      await getDb().execute({
        sql:
          `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          await encrypt("formmanager"),
          managerIdx,
          "",
          null,
          await encrypt("manager"),
        ],
      });
      invalidateUsersCache();

      await createSession(
        "mgr-form-session",
        "mgr-form-csrf",
        Date.now() + 3600000,
        null,
        2,
      );

      // Manager trying to POST to owner-only settings endpoint
      // Must use a signed CSRF token so verification passes and the role check is reached
      const { signCsrfToken } = await import("#lib/csrf.ts");
      const signedCsrf = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "test",
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: signedCsrf,
          },
          `${getSessionCookieName()}=mgr-form-session`,
        ),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("fields.ts (username validation)", () => {
    test("validateUsername rejects short username", async () => {
      const { validateUsername } = await import("#templates/fields.ts");
      expect(validateUsername("a")).toBe(
        "Username must be at least 2 characters",
      );
    });

    test("validateUsername rejects long username", async () => {
      const { validateUsername } = await import("#templates/fields.ts");
      expect(validateUsername("a".repeat(33))).toBe(
        "Username must be 32 characters or fewer",
      );
    });

    test("validateUsername rejects special characters", async () => {
      const { validateUsername } = await import("#templates/fields.ts");
      const result = validateUsername("user name");
      expect(result).toContain("letters, numbers");
    });

    test("validateUsername accepts valid username", async () => {
      const { validateUsername } = await import("#templates/fields.ts");
      expect(validateUsername("valid_user-1")).toBeNull();
    });
  });

  describe("session with deleted user", () => {
    test("session with nonexistent user_id is rejected", async () => {
      // Create a session pointing to a nonexistent user
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
      const { cookie, csrfToken } = await loginAsAdmin();

      // Corrupt the owner's wrapped_data_key (password verification will still pass, but unwrap will fail)
      await getDb().execute({
        sql: "UPDATE users SET wrapped_data_key = 'corrupted_key' WHERE id = 1",
        args: [],
      });
      invalidateUsersCache();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 500, "Failed to update password");
    });
  });

  describe("settings user not found", () => {
    test("password change returns 500 when user is deleted mid-request", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Delete the user while session still exists
      await getDb().execute({
        sql: "DELETE FROM users WHERE id = 1",
        args: [],
      });
      invalidateUsersCache();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      // Session auth check should redirect since user was deleted
      expect(response.status).toBe(302);
    });
  });

  describe("audit logging", () => {
    test("logs activity when user is invited", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "auditinvite",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) =>
          l.message.includes("User 'auditinvite' invited as manager")
        ),
      ).toBe(true);
    });

    test("logs activity when user is activated", async () => {
      const { inviteCode, cookie, csrfToken } = await createTestInvite(
        "auditactivate",
      );

      await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });

      // Activate
      await handleRequest(
        mockFormRequest(
          "/admin/users/2/activate",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("User 'auditactivate' activated")),
      ).toBe(true);
    });

    test("logs activity when user is deleted", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            username: "auditdelete",
            admin_level: "manager",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      await handleRequest(
        mockFormRequest(
          "/admin/users/2/delete",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("User 'auditdelete' deleted")))
        .toBe(true);
    });
  });

  describe("join.ts edge cases", () => {
    test("POST /join/:code withValidInvite extracts code from params", async () => {
      // POST to nonexistent invite code
      const response = await handleRequest(
        mockFormRequest(
          "/join/nonexistent-code",
          {
            password: "testpass123",
            password_confirm: "testpass123",
            csrf_token: "csrf",
          },
        ),
      );
      expect(response.status).toBe(404);
    });
  });
});
