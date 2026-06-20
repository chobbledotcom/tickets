import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import { getDb } from "#shared/db/client.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import {
  adminFormPost,
  assertPublicHtml,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  testCookie,
} from "#test-utils";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("navigation", () => {
    test("owner sees all nav links", async () => {
      const response = await awaitTestRequest("/admin/", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Settings");
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
      expect(html).not.toContain("Users");
    });

    test("manager sees log nav link", async () => {
      const cookie = await createTestManagerSession(
        "navmgr-log-session",
        "navmanagerlog",
      );
      const dashboardResponse = await awaitTestRequest("/admin/", { cookie });
      const html = await dashboardResponse.text();
      expect(html).toContain("/admin/log");
    });
  });

  describe("setup page", () => {
    test("setup includes admin_username field", async () => {
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      await getDbFn().execute("DELETE FROM settings");
      await getDbFn().execute("DELETE FROM users");
      const { settings: s } = await import("#shared/db/settings.ts");
      s.setup.clearCache();
      s.invalidateCache();
      invalidateUsersCache();

      await assertPublicHtml("/setup/", "admin_username");
    });
  });

  describe("users template rendering", () => {
    test("shows Invited status for user without password", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "invited-only",
      });

      const response = await awaitTestRequest("/admin/users", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Invited");
    });

    test("shows Invite Expired status for expired invite", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "expired-display",
      });

      const expiredExpiry = await encrypt(
        new Date(Date.now() - 1000).toISOString(),
      );
      await getDb().execute({
        args: [expiredExpiry],
        sql: "UPDATE users SET invite_expiry = ? WHERE id = 2",
      });
      invalidateUsersCache();

      const response = await awaitTestRequest("/admin/users", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Invite Expired");
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

  describe("audit logging", () => {
    test("logs activity when user is invited", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "auditinvite",
      });

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) =>
          l.message.includes("User 'auditinvite' invited as manager"),
        ),
      ).toBe(true);
    });

    test("logs activity when user is deleted", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "auditdelete",
      });

      await adminFormPost("/admin/users/2/delete", {
        confirm_identifier: "auditdelete",
      });

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("User 'auditdelete' deleted")),
      ).toBe(true);
    });
  });
});
