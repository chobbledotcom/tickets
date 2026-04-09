import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#lib/csrf.ts";
import {
  adminUserDeletePage,
  adminUsersPage,
  type DisplayUser,
} from "#templates/admin/users.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminUsersPage", () => {
  test("renders statuses and actions for different user states", () => {
    const users: DisplayUser[] = [
      {
        id: 1,
        username: "owner",
        adminLevel: "owner",
        hasPassword: true,
        hasDataKey: true,
        inviteExpired: false,
      },
      {
        id: 2,
        username: "pending",
        adminLevel: "manager",
        hasPassword: true,
        hasDataKey: false,
        inviteExpired: false,
      },
      {
        id: 3,
        username: "invited",
        adminLevel: "manager",
        hasPassword: false,
        hasDataKey: false,
        inviteExpired: false,
      },
    ];
    const html = adminUsersPage(users, TEST_SESSION, {
      inviteLink: "",
      success: "",
      error: "",
      currentUserId: 1,
    });
    expect(html).toContain("Active");
    expect(html).toContain("Pending Activation");
    expect(html).toContain("Invited");
    expect(html).toContain('action="/admin/users/2/activate"');
    expect(html).toContain('href="/admin/users/2/delete"');
    expect(html).toContain('href="/admin/users/3/delete"');
    expect(html).not.toContain('href="/admin/users/1/delete"');
  });

  test("renders Invite Expired status for expired invite", () => {
    const users: DisplayUser[] = [
      {
        id: 1,
        username: "owner",
        adminLevel: "owner",
        hasPassword: true,
        hasDataKey: true,
        inviteExpired: false,
      },
      {
        id: 2,
        username: "expired-user",
        adminLevel: "manager",
        hasPassword: false,
        hasDataKey: false,
        inviteExpired: true,
      },
    ];
    const html = adminUsersPage(users, TEST_SESSION, {
      inviteLink: "",
      success: "",
      error: "",
      currentUserId: 1,
    });
    expect(html).toContain("Invite Expired");
  });

  test("renders invite, success, and error messages when provided", () => {
    const users: DisplayUser[] = [
      {
        id: 1,
        username: "owner",
        adminLevel: "owner",
        hasPassword: true,
        hasDataKey: true,
        inviteExpired: false,
      },
    ];
    const html = adminUsersPage(users, TEST_SESSION, {
      inviteLink: "https://example.com/join/abc123",
      success: "Invite created",
      error: "Something went wrong",
      currentUserId: 1,
    });
    expect(html).toContain("Invite link (share this with the new user)");
    expect(html).toContain("https://example.com/join/abc123");
    expect(html).toContain("Invite created");
    expect(html).toContain("Something went wrong");
  });
});

describe("adminUserDeletePage", () => {
  test("renders delete confirmation form with username", () => {
    const user: DisplayUser = {
      id: 5,
      username: "targetuser",
      adminLevel: "manager",
      hasPassword: true,
      hasDataKey: true,
      inviteExpired: false,
    };
    const html = adminUserDeletePage(user, TEST_SESSION);
    expect(html).toContain("Delete User");
    expect(html).toContain("targetuser");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/users/5/delete"');
    expect(html).toContain("permanently delete");
  });

  test("renders error message when provided", () => {
    const user: DisplayUser = {
      id: 5,
      username: "targetuser",
      adminLevel: "owner",
      hasPassword: true,
      hasDataKey: true,
      inviteExpired: false,
    };
    const html = adminUserDeletePage(
      user,
      TEST_SESSION,
      "Username does not match",
    );
    expect(html).toContain("Username does not match");
  });
});
