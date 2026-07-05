import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminUserDeletePage,
  adminUserManagePage,
  adminUsersPage,
  type DisplayUser,
} from "#templates/admin/users.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

/** Factory for a {@link DisplayUser} with the common defaults. Only `id`,
 *  `adminLevel`, `username`, and `inviteExpired` vary between tests. */
const displayUser = (overrides: Partial<DisplayUser> = {}): DisplayUser => ({
  activated: true,
  adminLevel: "owner",
  id: 1,
  inviteExpired: false,
  username: "owner",
  ...overrides,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminUsersPage", () => {
  test("renders statuses and links each username to its manage page", () => {
    const users: DisplayUser[] = [
      displayUser(),
      displayUser({
        activated: false,
        adminLevel: "manager",
        id: 2,
        username: "pending",
      }),
      displayUser({
        activated: false,
        adminLevel: "manager",
        id: 3,
        username: "invited",
      }),
    ];
    const html = adminUsersPage(users, TEST_SESSION, {
      currentUserId: 1,
      error: "",
      inviteLink: "",
      success: "",
    });
    expect(html).toContain("Active");
    expect(html).toContain("Invited");
    // The username links to the per-user manage page; the delete action lives
    // there now, not inline in the table. There is no activate action — invited
    // users self-activate at /join.
    expect(html).toContain('<a href="/admin/users/2">pending</a>');
    expect(html).toContain('<a href="/admin/users/3">invited</a>');
    expect(html).not.toContain("/activate");
    expect(html).not.toContain("/delete");
  });

  test("renders Invite Expired status for expired invite", () => {
    const users: DisplayUser[] = [
      displayUser(),
      displayUser({
        activated: false,
        adminLevel: "manager",
        id: 2,
        inviteExpired: true,
        username: "expired-user",
      }),
    ];
    const html = adminUsersPage(users, TEST_SESSION, {
      currentUserId: 1,
      error: "",
      inviteLink: "",
      success: "",
    });
    expect(html).toContain("Invite Expired");
  });

  test("renders invite, success, and error messages when provided", () => {
    const users: DisplayUser[] = [
      {
        activated: true,
        adminLevel: "owner",
        id: 1,
        inviteExpired: false,
        username: "owner",
      },
    ];
    const html = adminUsersPage(users, TEST_SESSION, {
      currentUserId: 1,
      error: "Something went wrong",
      inviteLink: "https://example.com/join/abc123",
      success: "Invite created",
    });
    expect(html).toContain("Invite link (share this with the new user)");
    expect(html).toContain("https://example.com/join/abc123");
    expect(html).toContain("Invite created");
    expect(html).toContain("Something went wrong");
  });
});

describe("adminUserManagePage", () => {
  const manager: DisplayUser = {
    activated: false,
    adminLevel: "manager",
    id: 2,
    inviteExpired: false,
    username: "pending",
  };

  test("shows the delete section for another user", () => {
    const html = adminUserManagePage(manager, TEST_SESSION, {
      currentUserId: 1,
    });
    expect(html).toContain('href="/admin/users/2/delete"');
  });

  test("hides the delete section for the current user", () => {
    const html = adminUserManagePage(manager, TEST_SESSION, {
      currentUserId: 2,
    });
    expect(html).not.toContain('href="/admin/users/2/delete"');
  });

  test("shows edit-agents link and assigned agent names for an agent user", () => {
    const agent: DisplayUser = {
      activated: true,
      adminLevel: "agent",
      agentNames: ["Van 1"],
      id: 4,
      inviteExpired: false,
      username: "driver",
    };
    const html = adminUserManagePage(agent, TEST_SESSION, { currentUserId: 1 });
    expect(html).toContain('href="/admin/users/4/agents"');
    expect(html).toContain("Van 1");
  });

  test("shows a placeholder when an agent user has no assigned agents", () => {
    const agent: DisplayUser = {
      activated: true,
      adminLevel: "agent",
      agentNames: [],
      id: 4,
      inviteExpired: false,
      username: "driver",
    };
    const html = adminUserManagePage(agent, TEST_SESSION, { currentUserId: 1 });
    expect(html).toContain("No agents assigned");
  });
});

describe("adminUserDeletePage", () => {
  test("renders delete confirmation form with username", () => {
    const user: DisplayUser = {
      activated: true,
      adminLevel: "manager",
      id: 5,
      inviteExpired: false,
      username: "targetuser",
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
      activated: true,
      adminLevel: "owner",
      id: 5,
      inviteExpired: false,
      username: "targetuser",
    };
    const html = adminUserDeletePage(
      user,
      TEST_SESSION,
      "Username does not match",
    );
    expect(html).toContain("Username does not match");
  });
});
