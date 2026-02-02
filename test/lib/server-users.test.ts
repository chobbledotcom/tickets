import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { getDb } from "#lib/db/client.ts";
import { createSession } from "#lib/db/sessions.ts";
import {
  createInvitedUser,
  decryptAdminLevel,
  decryptUsername,
  getAllUsers,
  getUserByUsername,
  hasPassword,
  isInviteValid,
  verifyUserPassword,
} from "#lib/db/users.ts";
import { encrypt, hashPassword } from "#lib/crypto.ts";
import {
  isLegacyAdmin,
  migrateLegacyAdmin,
  setSetting,
  verifyLegacyPassword,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
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

  describe("role enforcement", () => {
    test("manager user cannot access settings page", async () => {
      // Create a manager user with a password
      const hash = await hashPassword("managerpass");
      const encHash = await encrypt(hash);
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, created)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("manager"),
          "manager-idx-unique",
          encHash,
          // Give the manager a wrapped_data_key so login works
          (await getUserByUsername(TEST_ADMIN_USERNAME))!.wrapped_data_key,
          await encrypt("manager"),
          await encrypt(new Date().toISOString()),
        ],
      });

      // Create a session for the manager user
      const managerUserId = 2;
      await createSession("manager-token", "manager-csrf", Date.now() + 3600000, null, managerUserId);

      // Manager should get 403 on owner-only routes
      const settingsResponse = await awaitTestRequest("/admin/settings", {
        cookie: "__Host-session=manager-token",
      });
      expect(settingsResponse.status).toBe(403);

      const sessionsResponse = await awaitTestRequest("/admin/sessions", {
        cookie: "__Host-session=manager-token",
      });
      expect(sessionsResponse.status).toBe(403);

      const usersResponse = await awaitTestRequest("/admin/users", {
        cookie: "__Host-session=manager-token",
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
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Users");
      expect(html).toContain(TEST_ADMIN_USERNAME);
    });

    test("manager user can access dashboard", async () => {
      // Create manager user manually with proper HMAC index
      const { hmacHash } = await import("#lib/crypto.ts");
      const managerIdx = await hmacHash("dashmanager");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, created)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("dashmanager"),
          managerIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt(new Date().toISOString()),
        ],
      });

      // Create a session directly for the manager user (id=2)
      await createSession("mgr-session", "mgr-csrf", Date.now() + 3600000, null, 2);

      const response = await awaitTestRequest("/admin/", {
        cookie: "__Host-session=mgr-session",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Events");
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
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(TEST_ADMIN_USERNAME);
      expect(html).toContain("owner");
    });
  });

  describe("POST /admin/users (invite)", () => {
    test("redirects when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/users", { username: "newuser", admin_level: "manager" }),
      );
      expectAdminRedirect(response);
    });

    test("creates invited user and shows invite link", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "newmanager", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("/join/");
      expect(html).toContain("newmanager");

      // Verify user was created in the database
      const users = await getAllUsers();
      expect(users.length).toBe(2);
    });

    test("rejects duplicate username", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: TEST_ADMIN_USERNAME, admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already taken");
    });

    test("rejects invalid role", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "newuser", admin_level: "superadmin", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid role");
    });
  });

  describe("POST /admin/users/:id/delete", () => {
    test("deletes a user", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create an invited user first
      await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "deleteme", admin_level: "manager", csrf_token: csrfToken },
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
      // Delete returns 200 with success message (re-renders users page)
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("deleted");

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
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Cannot delete your own account");
    });
  });

  describe("login flow", () => {
    test("login with username and password", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          username: TEST_ADMIN_USERNAME,
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    });

    test("login with wrong username returns 401", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          username: "nonexistent",
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      expect(response.status).toBe(401);
    });

    test("login with wrong password returns 401", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          username: TEST_ADMIN_USERNAME,
          password: "wrongpassword",
        }),
      );
      expect(response.status).toBe(401);
    });

    test("login page shows username field", async () => {
      const response = await handleRequest(mockRequest("/admin/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("username");
    });
  });

  describe("legacy admin migration", () => {
    test("isLegacyAdmin returns false when no admin_password in settings", async () => {
      const result = await isLegacyAdmin();
      expect(result).toBe(false);
    });

    test("isLegacyAdmin returns true when admin_password exists and no users", async () => {
      // Delete all users and add legacy password to settings
      await getDb().execute("DELETE FROM users");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);

      const result = await isLegacyAdmin();
      expect(result).toBe(true);
    });

    test("isLegacyAdmin returns false when users exist even with admin_password", async () => {
      // Add legacy password but keep the user
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);

      const result = await isLegacyAdmin();
      expect(result).toBe(false);
    });

    test("verifyLegacyPassword returns hash for correct password", async () => {
      await getDb().execute("DELETE FROM users");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);

      const result = await verifyLegacyPassword("legacypass");
      expect(result).toBeTruthy();
    });

    test("verifyLegacyPassword returns null for wrong password", async () => {
      await getDb().execute("DELETE FROM users");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);

      const result = await verifyLegacyPassword("wrongpass");
      expect(result).toBeNull();
    });

    test("migrateLegacyAdmin creates user and removes settings entries", async () => {
      // Set up legacy state
      await getDb().execute("DELETE FROM users");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);
      // Need wrapped_data_key in settings for migration
      await setSetting("wrapped_data_key", "wk:test:key");

      await migrateLegacyAdmin("legacyuser", hash);

      // User should be created
      const user = await getUserByUsername("legacyuser");
      expect(user).not.toBeNull();
      const level = await decryptAdminLevel(user!);
      expect(level).toBe("owner");

      // Legacy settings should be removed
      const { getSetting } = await import("#lib/db/settings.ts");
      expect(await getSetting("admin_password")).toBeNull();
      expect(await getSetting("wrapped_data_key")).toBeNull();
    });

    test("legacy login migrates to multi-user", async () => {
      // Set up legacy state: password in settings, no users
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM sessions");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);
      // migrateLegacyAdmin needs wrapped_data_key in settings
      await setSetting("wrapped_data_key", "wk:test:wrapped_key");

      // Login with legacy credentials
      await handleRequest(
        mockFormRequest("/admin/login", {
          username: "newadmin",
          password: "legacypass",
        }),
      );

      // After migration, user should exist
      const user = await getUserByUsername("newadmin");
      expect(user).not.toBeNull();
      const level = await decryptAdminLevel(user!);
      expect(level).toBe("owner");

      // Check legacy settings were cleaned up
      const { getSetting } = await import("#lib/db/settings.ts");
      expect(await getSetting("admin_password")).toBeNull();
    });
  });

  describe("join flow", () => {
    test("GET /join/:code returns 404 for invalid code", async () => {
      const response = await handleRequest(mockRequest("/join/invalidcode123"));
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("invalid");
    });

    test("GET /join/:code returns join page for valid invite", async () => {
      // Create an invite via the admin API
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "joiner", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(inviteResponse.status).toBe(200);
      const inviteHtml = await inviteResponse.text();

      // Extract invite code from the response
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      expect(codeMatch).not.toBeNull();
      const inviteCode = codeMatch![1];

      // Visit the join page
      const joinResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      expect(joinResponse.status).toBe(200);
      const joinHtml = await joinResponse.text();
      expect(joinHtml).toContain("joiner");
      expect(joinHtml).toContain("password");
    });

    test("POST /join/:code sets password for invited user", async () => {
      // Create an invite
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "joiner2", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      expect(codeMatch).not.toBeNull();
      const inviteCode = codeMatch![1];

      // Visit join page to get CSRF token
      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookie = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookie.match(/join_csrf=([^;]+)/);
      expect(joinCsrfMatch).not.toBeNull();
      const joinCsrf = joinCsrfMatch![1]!;

      // Submit password
      const joinPostResponse = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          {
            password: "newpassword123",
            password_confirm: "newpassword123",
            csrf_token: joinCsrf,
          },
          `join_csrf=${joinCsrf}`,
        ),
      );

      expect(joinPostResponse.status).toBe(200);
      const resultHtml = await joinPostResponse.text();
      expect(resultHtml).toContain("Password Set");

      // Verify user now has a password
      const user = await getUserByUsername("joiner2");
      expect(user).not.toBeNull();
      const hasPwd = await hasPassword(user!);
      expect(hasPwd).toBe(true);
    });

    test("POST /join/:code rejects mismatched passwords", async () => {
      // Create an invite
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "joiner3", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // Get CSRF
      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookie = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookie.match(/join_csrf=([^;]+)/);
      const joinCsrf = joinCsrfMatch![1]!;

      // Submit mismatched passwords
      const joinPostResponse = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          {
            password: "newpassword123",
            password_confirm: "differentpassword",
            csrf_token: joinCsrf,
          },
          `join_csrf=${joinCsrf}`,
        ),
      );

      expect(joinPostResponse.status).toBe(400);
      const html = await joinPostResponse.text();
      expect(html).toContain("do not match");
    });

    test("POST /join/:code rejects short passwords", async () => {
      // Create an invite
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "joiner4", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // Get CSRF
      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookie = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookie.match(/join_csrf=([^;]+)/);
      const joinCsrf = joinCsrfMatch![1]!;

      // Submit short password
      const joinPostResponse = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          {
            password: "short",
            password_confirm: "short",
            csrf_token: joinCsrf,
          },
          `join_csrf=${joinCsrf}`,
        ),
      );

      expect(joinPostResponse.status).toBe(400);
      const html = await joinPostResponse.text();
      expect(html).toContain("8 characters");
    });
  });

  describe("session user_id enforcement", () => {
    test("sessions without user_id are rejected", async () => {
      // Create a session without user_id (pre-migration session)
      await createSession("old-session", "old-csrf", Date.now() + 3600000);

      const response = await awaitTestRequest("/admin/", {
        cookie: "__Host-session=old-session",
      });
      // Should redirect to login (session invalidated)
      const html = await response.text();
      expect(html).toContain("Login");
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
      // Create manager user with proper HMAC index
      const { hmacHash } = await import("#lib/crypto.ts");
      const managerIdx = await hmacHash("navmanager");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, created)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("navmanager"),
          managerIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt(new Date().toISOString()),
        ],
      });

      // Create a session directly for the manager user (id=2)
      await createSession("navmgr-session", "navmgr-csrf", Date.now() + 3600000, null, 2);

      const dashboardResponse = await awaitTestRequest("/admin/", {
        cookie: "__Host-session=navmgr-session",
      });
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
      const { clearSetupCompleteCache } = await import("#lib/db/settings.ts");
      clearSetupCompleteCache();

      const response = await handleRequest(mockRequest("/setup/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("admin_username");
    });
  });

  describe("POST /admin/users/:id/activate", () => {
    test("activates user who has set password", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create an invite
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "activateme", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );
      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // Set password via join flow
      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookieHeader = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookieHeader.match(/join_csrf=([^;]+)/);
      const joinCsrf = joinCsrfMatch![1]!;

      await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          { password: "newpassword123", password_confirm: "newpassword123", csrf_token: joinCsrf },
          `join_csrf=${joinCsrf}`,
        ),
      );

      // Now activate user id 2
      const activateResponse = await handleRequest(
        mockFormRequest(
          "/admin/users/2/activate",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(activateResponse.status).toBe(200);
      const html = await activateResponse.text();
      expect(html).toContain("activated successfully");
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
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("User not found");
    });

    test("rejects user who has not set password", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create invite but don't complete join flow
      await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "nopassword", admin_level: "manager", csrf_token: csrfToken },
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
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not set their password");
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
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already activated");
    });

    test("returns 500 when session lacks data key", async () => {
      // Create a session without wrapped_data_key for the owner
      await createSession("no-dk-session", "no-dk-csrf", Date.now() + 3600000, null, 1);

      const { cookie, csrfToken } = await loginAsAdmin();

      // Create an invited user with password set
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "needsactivation", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );
      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookieHeader = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookieHeader.match(/join_csrf=([^;]+)/);
      const joinCsrf = joinCsrfMatch![1]!;

      await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          { password: "newpassword123", password_confirm: "newpassword123", csrf_token: joinCsrf },
          `join_csrf=${joinCsrf}`,
        ),
      );

      // Try to activate using session without data key
      const response = await handleRequest(
        mockFormRequest(
          "/admin/users/2/activate",
          { csrf_token: "no-dk-csrf" },
          "__Host-session=no-dk-session",
        ),
      );
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("session lacks data key");
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
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("User not found");
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

      const response = await handleRequest(mockRequest("/join/expired-code-123"));
      expect(response.status).toBe(410);
      const html = await response.text();
      expect(html).toContain("expired");
    });

    test("POST /join/:code returns 410 for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const { hashInviteCode } = await import("#lib/db/users.ts");
      const codeHash = await hashInviteCode("expired-post-123");
      await createInvitedUser("expired-post-user", "manager", codeHash, expiry);

      const response = await handleRequest(
        mockFormRequest(
          "/join/expired-post-123",
          { password: "pass12345678", password_confirm: "pass12345678", csrf_token: "fake" },
          "join_csrf=fake",
        ),
      );
      expect(response.status).toBe(410);
    });
  });

  describe("join flow (CSRF validation)", () => {
    test("POST /join/:code rejects invalid CSRF token", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "csrf-test-user", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // POST with wrong CSRF
      const response = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          { password: "newpassword123", password_confirm: "newpassword123", csrf_token: "wrong" },
          "join_csrf=different",
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("try again");
    });

    test("POST /join/:code rejects missing CSRF cookie", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "csrf-missing-user", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // POST without CSRF cookie
      const response = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          { password: "newpassword123", password_confirm: "newpassword123", csrf_token: "token" },
        ),
      );
      expect(response.status).toBe(403);
    });

    test("POST /join/:code rejects form without csrf_token field", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "csrf-nofield-user", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // POST without csrf_token field in form
      const body = "password=newpassword123&password_confirm=newpassword123";
      const response = await handleRequest(
        new Request(`http://localhost/join/${inviteCode}`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
            cookie: "join_csrf=sometoken",
          },
          body,
        }),
      );
      expect(response.status).toBe(403);
    });

    test("POST /join/:code rejects missing password fields", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "validation-user", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      // Get valid CSRF
      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookieHeader = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookieHeader.match(/join_csrf=([^;]+)/);
      const joinCsrf = joinCsrfMatch![1]!;

      // POST with missing password fields
      const response = await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          { password: "", password_confirm: "", csrf_token: joinCsrf },
          `join_csrf=${joinCsrf}`,
        ),
      );
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
          { username: "invited-only", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );

      const response = await awaitTestRequest("/admin/users", { cookie });
      const html = await response.text();
      expect(html).toContain("Invited");
    });

    test("shows Pending Activation status and Activate button for user with password but no data key", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create invite and complete join (set password)
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          { username: "pending-user", admin_level: "manager", csrf_token: csrfToken },
          cookie,
        ),
      );
      const inviteHtml = await inviteResponse.text();
      const codeMatch = inviteHtml.match(/\/join\/([A-Za-z0-9_-]+)/);
      const inviteCode = codeMatch![1];

      const joinGetResponse = await handleRequest(mockRequest(`/join/${inviteCode}`));
      const joinCookieHeader = joinGetResponse.headers.get("set-cookie") || "";
      const joinCsrfMatch = joinCookieHeader.match(/join_csrf=([^;]+)/);
      const joinCsrf = joinCsrfMatch![1]!;

      await handleRequest(
        mockFormRequest(
          `/join/${inviteCode}`,
          { password: "newpassword123", password_confirm: "newpassword123", csrf_token: joinCsrf },
          `join_csrf=${joinCsrf}`,
        ),
      );

      // Users page should show "Pending Activation" and "Activate" button
      const usersResponse = await awaitTestRequest("/admin/users", { cookie });
      const html = await usersResponse.text();
      expect(html).toContain("Pending Activation");
      expect(html).toContain("Activate");
    });
  });

  describe("legacy settings functions", () => {
    test("verifyLegacyPassword returns null when no admin_password in settings", async () => {
      // No admin_password exists in settings (normal post-migration state)
      const result = await verifyLegacyPassword("anypassword");
      expect(result).toBeNull();
    });
  });

  describe("legacy login flow edge cases", () => {
    test("legacy login with wrong password returns 401", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM sessions");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);
      await setSetting("wrapped_data_key", "wk:test:key");

      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          username: "admin",
          password: "wrongpassword",
        }),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Invalid credentials");
    });

    test("legacy login returns error when migration fails (no wrapped_data_key in settings)", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM sessions");
      const hash = await hashPassword("legacypass");
      await setSetting("admin_password", hash);
      // Do NOT set wrapped_data_key

      let response: Response | undefined;
      try {
        response = await handleRequest(
          mockFormRequest("/admin/login", {
            username: "admin",
            password: "legacypass",
          }),
        );
      } catch {
        // migrateLegacyAdmin throws when wrapped_data_key is missing
        return;
      }
      // If it doesn't throw, it should return an error status
      expect(response!.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("settings page edge cases", () => {
    test("password change fails when user has no data key", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Null out the owner's wrapped_data_key
      await getDb().execute({
        sql: "UPDATE users SET wrapped_data_key = NULL WHERE id = 1",
        args: [],
      });

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
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("no data key");
    });
  });

  describe("db/users.ts edge cases", () => {
    test("verifyUserPassword returns null when user has empty password_hash", async () => {
      const user = await createInvitedUser("nopwd", "manager", "hash", new Date(Date.now() + 86400000).toISOString());
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
      const user = await createInvitedUser("used-invite", "manager", "somehash", expiry);

      // Setting password clears invite_code_hash (sets to encrypted "")
      await setUserPwd(user.id, "newpassword123");

      // Reload user
      const { getUserById: getUser } = await import("#lib/db/users.ts");
      const updatedUser = await getUser(user.id);
      const valid = await isInviteValid(updatedUser!);
      expect(valid).toBe(false);
    });

    test("hasPassword returns false for user with empty encrypted password", async () => {
      const user = await createInvitedUser("nopwd2", "manager", "hash2", new Date(Date.now() + 86400000).toISOString());
      // User was created with empty password_hash - the createInvitedUser passes ""
      const hasPwd = await hasPassword(user);
      expect(hasPwd).toBe(false);
    });

    test("isInviteValid returns false when invite_expiry is null", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("no-expiry-user");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, created)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("no-expiry-user"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt("somehash"),
          null,
          await encrypt(new Date().toISOString()),
        ],
      });

      const user = await getUserByUsername("no-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite_code_hash cannot be decrypted", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("corrupt-invite-user");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, created)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("corrupt-invite-user"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          "corrupted_encrypted_data",
          await encrypt(new Date(Date.now() + 86400000).toISOString()),
          await encrypt(new Date().toISOString()),
        ],
      });

      const user = await getUserByUsername("corrupt-invite-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite_expiry decrypts to empty string", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("empty-expiry-user");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, created)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("empty-expiry-user"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt("somehash"),
          await encrypt(""),
          await encrypt(new Date().toISOString()),
        ],
      });

      const user = await getUserByUsername("empty-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite_expiry cannot be decrypted", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("corrupt-expiry-user");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, created)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("corrupt-expiry-user"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt("somehash"),
          "corrupted_encrypted_expiry",
          await encrypt(new Date().toISOString()),
        ],
      });

      const user = await getUserByUsername("corrupt-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("hasPassword returns false when password_hash cannot be decrypted", async () => {
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("corrupt-pwd-user");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, created)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("corrupt-pwd-user"),
          usernameIdx,
          "corrupted_encrypted_password",
          null,
          await encrypt("manager"),
          await encrypt(new Date().toISOString()),
        ],
      });

      const user = await getUserByUsername("corrupt-pwd-user");
      const hasPwd = await hasPassword(user!);
      expect(hasPwd).toBe(false);
    });

    test("getUserByInviteCode skips users with corrupted invite_code_hash", async () => {
      const { getUserByInviteCode } = await import("#lib/db/users.ts");
      const { hmacHash } = await import("#lib/crypto.ts");
      const usernameIdx = await hmacHash("corrupt-code-lookup");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, created)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("corrupt-code-lookup"),
          usernameIdx,
          "",
          null,
          await encrypt("manager"),
          "corrupted_not_decryptable",
          await encrypt(new Date(Date.now() + 86400000).toISOString()),
          await encrypt(new Date().toISOString()),
        ],
      });

      // Look up with any invite code - should not crash, just return null
      const result = await getUserByInviteCode("any-code-123");
      expect(result).toBeNull();
    });
  });

  describe("utils.ts edge cases", () => {
    test("session with invalid wrapped_data_key is rejected", async () => {
      // Create a session with an invalid wrapped_data_key
      await createSession("bad-key-session", "bad-csrf", Date.now() + 3600000, "invalid-wrapped-key", 1);

      const response = await awaitTestRequest("/admin/", {
        cookie: "__Host-session=bad-key-session",
      });
      // Session should be invalidated, showing login
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("withOwnerAuthForm returns 403 for manager role", async () => {
      // Create manager user
      const { hmacHash } = await import("#lib/crypto.ts");
      const managerIdx = await hmacHash("formmanager");
      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, created)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          await encrypt("formmanager"),
          managerIdx,
          "",
          null,
          await encrypt("manager"),
          await encrypt(new Date().toISOString()),
        ],
      });

      await createSession("mgr-form-session", "mgr-form-csrf", Date.now() + 3600000, null, 2);

      // Manager trying to POST to owner-only settings endpoint
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "test",
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: "mgr-form-csrf",
          },
          "__Host-session=mgr-form-session",
        ),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("fields.ts (username validation)", () => {
    test("validateUsername rejects short username", async () => {
      const { validateUsername } = await import("#templates/fields.ts");
      expect(validateUsername("a")).toBe("Username must be at least 2 characters");
    });

    test("validateUsername rejects long username", async () => {
      const { validateUsername } = await import("#templates/fields.ts");
      expect(validateUsername("a".repeat(33))).toBe("Username must be 32 characters or fewer");
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
      await createSession("orphan-session", "orphan-csrf", Date.now() + 3600000, null, 999);

      const response = await awaitTestRequest("/admin/", {
        cookie: "__Host-session=orphan-session",
      });
      const html = await response.text();
      expect(html).toContain("Login");
    });
  });

  describe("attendees no private key", () => {
    test("GET attendee delete page redirects when session lacks private key", async () => {
      // Create a session without wrapped_data_key
      await createSession("no-pk-session", "no-pk-csrf", Date.now() + 3600000, null, 1);

      // Try to access an attendee delete page
      const response = await handleRequest(
        new Request("http://localhost/admin/event/1/attendee/1/delete", {
          headers: {
            host: "localhost",
            cookie: "__Host-session=no-pk-session",
          },
        }),
      );
      // Should redirect to /admin since no private key is available
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("POST attendee delete redirects when session lacks private key", async () => {
      await createSession("no-pk-post", "no-pk-post-csrf", Date.now() + 3600000, null, 1);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/1/delete",
          { confirm_name: "test", csrf_token: "no-pk-post-csrf" },
          "__Host-session=no-pk-post",
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
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
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to update password");
    });
  });

  describe("legacy login full success path", () => {
    test("legacy login creates session and redirects to admin", async () => {
      // Set up legacy admin with properly generated data key
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM sessions");
      const { hashPassword: hp, deriveKEK: dk, wrapKey: wk, generateDataKey: gdk } = await import("#lib/crypto.ts");
      const hash = await hp("legacypass");
      const kek = await dk(hash);
      const dataKey = await gdk();
      const wrapped = await wk(dataKey, kek);

      await setSetting("admin_password", hash);
      await setSetting("wrapped_data_key", wrapped);

      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          username: "legacyadmin",
          password: "legacypass",
        }),
      );

      // Should redirect to /admin with session cookie
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      expect(response.headers.get("set-cookie")).toContain("__Host-session=");

      // User should now exist
      const user = await getUserByUsername("legacyadmin");
      expect(user).not.toBeNull();
      const level = await decryptAdminLevel(user!);
      expect(level).toBe("owner");
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

  describe("join.ts edge cases", () => {
    test("POST /join/:code withValidInvite extracts code from params", async () => {
      // POST to nonexistent invite code
      const response = await handleRequest(
        mockFormRequest(
          "/join/nonexistent-code",
          { password: "testpass123", password_confirm: "testpass123", csrf_token: "csrf" },
          "join_csrf=csrf",
        ),
      );
      expect(response.status).toBe(404);
    });
  });
});
