import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminUserDeletePage,
  adminUserNewPage,
  adminUsersPage,
  type DisplayUser,
  UserAgentsPanel,
} from "#templates/admin/users.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import type { LogisticsAgent } from "#types";

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
      'name="confirmIdentifier"',
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

const VANS: LogisticsAgent[] = [
  { id: 1, name: "Van 1" },
  { id: 2, name: "Van 2" },
];

const AGENT_HINT =
  "Delivery agents see the run sheet only for the logistics agents ticked here. Ignored for owners and managers.";

const panelHtml = (agents: LogisticsAgent[]): string =>
  String(
    UserAgentsPanel({
      action: "/admin/users/7/agents",
      agents,
      selectedIds: new Set([2]),
      user: displayUser({ adminLevel: "agent", id: 7, username: "driver" }),
    }),
  );

describe("adminUsersPage agent names", () => {
  beforeAll(setupAdminPageTest);

  const agentRow = (agentNames: string[]) =>
    adminUsersPage(
      [displayUser({ adminLevel: "agent", agentNames, id: 4 })],
      OWNER_SESSION,
      { currentUserId: 1, inviteLink: "" },
    );

  test("joins several agent names with a comma and a space", () => {
    assertStringIncludes(
      agentRow(["Van 1", "Van 2"]),
      "<small>Van 1, Van 2</small>",
    );
  });

  test("shows the placeholder when an agent user has no agents", () => {
    assertStringIncludes(agentRow([]), "<small>No agents assigned</small>");
  });
});

describe("adminUserNewPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the invite form with its title, heading, and button", () => {
    const html = adminUserNewPage(OWNER_SESSION, []);
    expectIncludesAll(html, [
      "<title>Invite User</title>",
      "<h1>Invite User</h1>",
      'action="/admin/users"',
      "Create Invite",
      '<a class="active" href="/admin/users/new">',
    ]);
  });

  test("omits the agent selector when no agents exist", () => {
    const html = adminUserNewPage(OWNER_SESSION, []);
    assert(!html.includes("Assigned logistics agents"));
    assert(!html.includes('name="agentIds"'));
  });

  test("renders the agent selector with its legend, hint, and class", () => {
    const html = adminUserNewPage(OWNER_SESSION, VANS);
    expectIncludesAll(html, [
      '<fieldset class="checkboxes">',
      "<legend>Assigned logistics agents</legend>",
      `<small>${AGENT_HINT}</small>`,
      'name="agentIds"',
      "Van 1",
      "Van 2",
    ]);
  });

  test("renders the agent selector for exactly one agent", () => {
    const html = adminUserNewPage(OWNER_SESSION, [VANS[0] as LogisticsAgent]);
    expectIncludesAll(html, ['name="agentIds"', "Van 1"]);
  });
});

describe("UserAgentsPanel", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, selector, and save button when agents exist", () => {
    const html = panelHtml(VANS);
    expectIncludesAll(html, [
      "<h2>Assigned agents for driver</h2>",
      'action="/admin/users/7/agents"',
      '<fieldset class="checkboxes">',
      "<legend>Assigned logistics agents</legend>",
      `<small>${AGENT_HINT}</small>`,
      'checked name="agentIds" type="checkbox" value="2"',
      "Save Agents",
    ]);
    assert(!html.includes("No logistics agents exist yet"));
  });

  test("renders the form for exactly one agent", () => {
    const html = panelHtml([VANS[0] as LogisticsAgent]);
    expectIncludesAll(html, ["Save Agents", 'name="agentIds"']);
    assert(!html.includes("No logistics agents exist yet"));
  });

  test("links to Logistics when no agents exist", () => {
    const html = panelHtml([]);
    expectIncludesAll(html, [
      "<h2>Assigned agents for driver</h2>",
      "<em>No logistics agents exist yet. Add some under " +
        '<a href="/admin/logistics">Logistics</a>.</em>',
    ]);
    assert(!html.includes("Save Agents"));
    assert(!html.includes('name="agentIds"'));
  });
});
