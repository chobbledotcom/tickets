import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { AdminSession, LogisticsAgent } from "#shared/types.ts";
import {
  type AgentUserOption,
  adminLogisticsAgentEditPage,
} from "#templates/admin/logistics.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const session: AdminSession = { adminLevel: "owner" };
const agent: LogisticsAgent = { id: 7, name: "Van 1" };

const users: AgentUserOption[] = [
  { adminLevel: "agent", id: 1, username: "driver" },
  { adminLevel: "manager", id: 2, username: "boss" },
];

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminLogisticsAgentEditPage", () => {
  test("groups the form into agent-details and assigned-users fieldsets", () => {
    const html = adminLogisticsAgentEditPage(agent, users, new Set(), session);
    expect(html).toContain("<legend>Agent details</legend>");
    expect(html).toContain("<legend>Assigned users</legend>");
    expect(html).toContain("Van 1");
  });

  test("explains that agent-class users only see the deliveries page", () => {
    const html = adminLogisticsAgentEditPage(agent, users, new Set(), session);
    expect(html).toContain(
      "Agent-class users can only see the deliveries page",
    );
  });

  test("lists every user class as an assignable checkbox", () => {
    const html = adminLogisticsAgentEditPage(agent, users, new Set(), session);
    expect(html).toContain('name="user_ids"');
    expect(html).toContain("driver (agent)");
    expect(html).toContain("boss (manager)");
  });

  test("pre-checks the users already assigned to the agent", () => {
    const html = adminLogisticsAgentEditPage(
      agent,
      users,
      new Set([2]),
      session,
    );
    // The assigned user's checkbox is checked; the unassigned one is not.
    expect(html).toMatch(/value="2"[^>]*checked|checked[^>]*value="2"/);
    expect(html).not.toMatch(/value="1"[^>]*checked|checked[^>]*value="1"/);
  });

  test("shows a placeholder when there are no users to assign", () => {
    const html = adminLogisticsAgentEditPage(agent, [], new Set(), session);
    expect(html).toContain("No users to assign yet.");
  });
});
