import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";
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
    says(html, "Assigned logistics agents");
    says(html, '<fieldset class="checkboxes">');
    says(html, 'name="agent_ids"');
    says(html, "Van 1");
    says(html, 'value="2"');
    says(html, "Delivery agent");
    says(html, 'action="/admin/users"');
    says(html, '<a class="active" href="/admin/user/new">');
  });

  test("renders the agent checkboxes for a single agent", () => {
    const html = adminUserNewPage(OWNER_SESSION, [{ id: 1, name: "Van 1" }]);
    says(html, 'name="agent_ids"');
    says(html, "Van 1");
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
    says(html, "Assigned agents for driver");
    says(html, 'action="/admin/users/7/agents"');
    // Van 2 (id 2) is checked, Van 1 (id 1) is not.
    says(html, 'checked name="agent_ids" type="checkbox" value="2"');
    says(html, 'name="agent_ids" type="checkbox" value="1"');
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
    says(html, "No logistics agents exist yet");
    // The link and its leading space stay glued to the sentence that offers it.
    says(html, 'Add some under <a href="/admin/logistics">Logistics</a>.');
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
    says(html, "Van 1, Van 2");
    // The edit-agents link moved to the per-user manage page.
    says(html, '<a href="/admin/users/4">driver</a>');
    assert(!html.includes('href="/admin/users/4/agents"'));
  });

  test("shows a placeholder when an agent user has no agents", () => {
    const users: DisplayUser[] = [agentUser([])];
    const html = adminUsersPage(users, OWNER_SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    says(html, "No agents assigned");
  });
});
