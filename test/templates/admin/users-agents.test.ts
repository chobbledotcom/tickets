import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { LogisticsAgent } from "#shared/types.ts";
import {
  adminUserAgentsPage,
  adminUserNewPage,
  adminUsersPage,
  type DisplayUser,
} from "#templates/admin/users.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const SESSION = { adminLevel: "owner" as const };
const AGENTS: LogisticsAgent[] = [
  { id: 1, name: "Van 1" },
  { id: 2, name: "Van 2" },
];

/** The agent-user fixture used by both "shows assigned agent names" and
 *  "shows a placeholder when no agents" tests — only `agentNames` varies. */
const agentUser = (agentNames: string[]): DisplayUser => ({
  adminLevel: "agent",
  agentNames,
  hasDataKey: true,
  id: 4,
  inviteExpired: false,
  username: "driver",
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminUserNewPage agent selector", () => {
  test("renders the agent checkboxes when agents exist", () => {
    const html = adminUserNewPage(SESSION, AGENTS);
    expect(html).toContain("Assigned logistics agents");
    expect(html).toContain('name="agent_ids"');
    expect(html).toContain("Van 1");
    expect(html).toContain('value="2"');
    expect(html).toContain("Delivery agent");
  });

  test("omits the selector when there are no agents", () => {
    const html = adminUserNewPage(SESSION, []);
    expect(html).not.toContain("Assigned logistics agents");
  });
});

describe("adminUserAgentsPage", () => {
  const agentUser: DisplayUser = {
    adminLevel: "agent",
    hasDataKey: true,
    id: 7,
    inviteExpired: false,
    username: "driver",
  };

  test("pre-checks the agents already assigned", () => {
    const html = adminUserAgentsPage(agentUser, AGENTS, new Set([2]), SESSION);
    expect(html).toContain("Assigned agents for driver");
    expect(html).toContain('action="/admin/users/7/agents"');
    // Van 2 (id 2) is checked, Van 1 (id 1) is not.
    expect(html).toContain(
      'checked name="agent_ids" type="checkbox" value="2"',
    );
    expect(html).toContain('name="agent_ids" type="checkbox" value="1"');
    expect(html).not.toContain(
      'checked name="agent_ids" type="checkbox" value="1"',
    );
  });

  test("prompts to add agents when none exist", () => {
    const html = adminUserAgentsPage(agentUser, [], new Set(), SESSION);
    expect(html).toContain("No logistics agents exist yet");
  });
});

describe("adminUsersPage agent rows", () => {
  test("shows assigned agent names and links to the manage page for agent users", () => {
    const users: DisplayUser[] = [agentUser(["Van 1", "Van 2"])];
    const html = adminUsersPage(users, SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    expect(html).toContain("Van 1, Van 2");
    // The edit-agents link moved to the per-user manage page.
    expect(html).toContain('<a href="/admin/users/4">driver</a>');
    expect(html).not.toContain('href="/admin/users/4/agents"');
  });

  test("shows a placeholder when an agent user has no agents", () => {
    const users: DisplayUser[] = [agentUser([])];
    const html = adminUsersPage(users, SESSION, {
      currentUserId: 1,
      inviteLink: "",
    });
    expect(html).toContain("No agents assigned");
  });
});
