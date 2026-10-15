import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminUserDeletePage,
  adminUsersPage,
  type DisplayUser,
} from "#templates/admin/users.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

/** Factory for a {@link DisplayUser} with common defaults. */
const displayUser = (overrides: Partial<DisplayUser> = {}): DisplayUser => ({
  activated: true,
  adminLevel: "owner",
  id: 1,
  inviteExpired: false,
  username: "owner",
  ...overrides,
});

describe("adminUsersPage", () => {
  beforeAll(setupAdminPageTest);

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
    const html = adminUsersPage(users, OWNER_SESSION, {
      currentUserId: 1,
      error: "",
      inviteLink: "",
      success: "",
    });
    says(html, "Active");
    says(html, "Invited");
    // The username links to the per-user manage page; the delete action lives
    // there now, not inline in the table. There is no activate action — invited
    // users self-activate at /join.
    says(html, '<a href="/admin/users/2">pending</a>');
    says(html, '<a href="/admin/users/3">invited</a>');
    assert(!html.includes("/activate"));
    assert(!html.includes("/delete"));
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
    const html = adminUsersPage(users, OWNER_SESSION, {
      currentUserId: 1,
      error: "",
      inviteLink: "",
      success: "",
    });
    says(html, "Invite Expired");
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
    const html = adminUsersPage(users, OWNER_SESSION, {
      currentUserId: 1,
      error: "Something went wrong",
      inviteLink: "https://example.com/join/abc123",
      success: "Invite created",
    });
    says(html, "Invite link (share this with the new user)");
    // The invite alert is its own banner, not the page frame's flash copy.
    expect(html).toMatch(
      /class="success" role="alert">\s*<p>Invite link \(share this with the new user\)/,
    );
    says(html, "https://example.com/join/abc123");
    says(html, "Invite created");
    says(html, "Something went wrong");
  });

  test("marks the Users nav link active and links to the roles guide", () => {
    const html = adminUsersPage([displayUser()], OWNER_SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    says(html, '<a class="active" href="/admin/users">');
    says(html, 'href="/admin/guide#user-classes"');
  });

  test("shows an agent user's single assigned agent name", () => {
    const html = adminUsersPage(
      [
        displayUser({
          adminLevel: "agent",
          agentNames: ["Solo Van"],
          id: 4,
          username: "driver",
        }),
      ],
      OWNER_SESSION,
      { currentUserId: 1, inviteLink: "" },
    );
    says(html, "Solo Van");
    assert(!html.includes("No agents assigned"));
  });
});

describe("adminUserDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders delete confirmation form with username", () => {
    const user: DisplayUser = {
      activated: true,
      adminLevel: "manager",
      id: 5,
      inviteExpired: false,
      username: "targetuser",
    };
    const html = adminUserDeletePage(user, OWNER_SESSION);
    says(html, "Delete User");
    says(html, "targetuser");
    says(html, '<a class="active" href="/admin/users">');
    says(html, 'name="confirm_identifier"');
    says(html, 'action="/admin/users/5/delete"');
    says(html, "permanently delete");
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
      OWNER_SESSION,
      "Username does not match",
    );
    says(html, "Username does not match");
  });
});
