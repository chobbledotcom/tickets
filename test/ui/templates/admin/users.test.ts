import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminUserDeletePage,
  adminUsersPage,
  type DisplayUser,
} from "#templates/admin/users.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

const TEST_SESSION = { adminLevel: "owner" as const };

/** Factory for a {@link DisplayUser} with common defaults. */
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
