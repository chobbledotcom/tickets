import { assert, assertStringIncludes } from "@std/assert";
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
import { expectIncludesAll } from "#test-utils/assertions.ts";

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
    expectIncludesAll(html, [
      "Active",
      "Invited",
      // The username links to the per-user manage page; the delete action lives
      // there now, not inline in the table. There is no activate action — invited
      // users self-activate at /join.
      '<a href="/admin/users/2">pending</a>',
      '<a href="/admin/users/3">invited</a>',
    ]);
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
    assertStringIncludes(html, "Invite Expired");
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
    assertStringIncludes(html, "Invite link (share this with the new user)");
    // The invite alert is its own banner, not the page frame's flash copy.
    expect(html).toMatch(
      /class="success" role="alert">\s*<p>Invite link \(share this with the new user\)/,
    );
    expectIncludesAll(html, [
      "https://example.com/join/abc123",
      "Invite created",
      "Something went wrong",
    ]);
  });

  test("marks the Users nav link active and links to the roles guide", () => {
    const html = adminUsersPage([displayUser()], OWNER_SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    expectIncludesAll(html, [
      '<a class="active" href="/admin/users">',
      'href="/admin/guide#user-classes"',
    ]);
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
    assertStringIncludes(html, "Solo Van");
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
    expectIncludesAll(html, [
      "Delete User",
      "targetuser",
      '<a class="active" href="/admin/users">',
      'name="confirm_identifier"',
      'action="/admin/users/5/delete"',
      "permanently delete",
    ]);
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
    assertStringIncludes(html, "Username does not match");
  });
});
