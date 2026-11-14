import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
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

const AGENTS: LogisticsAgent[] = [
  { id: 1, name: "Van 1" },
  { id: 2, name: "Van 2" },
];

/** The agent-user fixture used by both "shows assigned agent names" and
 *  "shows a placeholder when no agents" tests — only `agentNames` varies. */
const agentUser = (agentNames: string[]): DisplayUser => ({
  activated: true,
  adminLevel: "agent",
  agentNames,
  id: 4,
  inviteExpired: false,
  username: "driver",
});

describe("adminUserNewPage agent selector", () => {
  beforeAll(setupAdminPageTest);

  test("renders the agent checkboxes when agents exist", () => {
    const html = adminUserNewPage(OWNER_SESSION, AGENTS);
    expectIncludesAll(html, [
      "Assigned logistics agents",
      '<fieldset class="checkboxes">',
      'name="agent_ids"',
      "Van 1",
      'value="2"',
      "Delivery agent",
      'action="/admin/users"',
      '<a class="active" href="/admin/users/new">',
    ]);
  });

  test("renders the agent checkboxes for a single agent", () => {
    const html = adminUserNewPage(OWNER_SESSION, [{ id: 1, name: "Van 1" }]);
    expectIncludesAll(html, ['name="agent_ids"', "Van 1"]);
  });

  test("omits the selector when there are no agents", () => {
    const html = adminUserNewPage(OWNER_SESSION, []);
    assert(!html.includes("Assigned logistics agents"));
  });
});

describe("UserAgentsPanel", () => {
  beforeAll(setupAdminPageTest);

  // The user whose agent assignments the page edits (distinct from the
  // agentUser factory above, which builds display-row fixtures).
  const editedUser: DisplayUser = {
    activated: true,
    adminLevel: "agent",
    id: 7,
    inviteExpired: false,
    username: "driver",
  };

  test("pre-checks the agents already assigned", () => {
    const html = String(
      UserAgentsPanel({
        action: "/admin/users/7/agents",
        agents: AGENTS,
        selectedIds: new Set([2]),
        user: editedUser,
      }),
    );
    expectIncludesAll(html, [
      "Assigned agents for driver",
      'action="/admin/users/7/agents"',
      // Van 2 (id 2) is checked, Van 1 (id 1) is not.
      'checked name="agent_ids" type="checkbox" value="2"',
      'name="agent_ids" type="checkbox" value="1"',
    ]);
    assert(
      !html.includes('checked name="agent_ids" type="checkbox" value="1"'),
    );
  });

  test("prompts to add agents when none exist", () => {
    const html = String(
      UserAgentsPanel({
        action: "/admin/users/7/agents",
        agents: [],
        selectedIds: new Set(),
        user: editedUser,
      }),
    );
    expectIncludesAll(html, [
      "No logistics agents exist yet",
      // The link and its leading space stay glued to the sentence that offers it.
      'Add some under <a href="/admin/logistics">Logistics</a>.',
    ]);
  });
});

describe("adminUsersPage agent rows", () => {
  beforeAll(setupAdminPageTest);

  test("shows assigned agent names and links to the manage page for agent users", () => {
    const users: DisplayUser[] = [agentUser(["Van 1", "Van 2"])];
    const html = adminUsersPage(users, OWNER_SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    expectIncludesAll(html, [
      "Van 1, Van 2",
      // The edit-agents link moved to the per-user manage page.
      '<a href="/admin/users/4">driver</a>',
    ]);
    assert(!html.includes('href="/admin/users/4/agents"'));
  });

  test("shows a placeholder when an agent user has no agents", () => {
    const users: DisplayUser[] = [agentUser([])];
    const html = adminUsersPage(users, OWNER_SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    assertStringIncludes(html, "No agents assigned");
  });
});
