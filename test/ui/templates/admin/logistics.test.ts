import { expect } from "@std/expect";
import { beforeAll, beforeEach, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { AdminSession, LogisticsAgent } from "#shared/types.ts";
import {
  type AgentUserOption,
  adminLogisticsAgentEditPage,
  adminLogisticsPage,
  logisticsAgentPages,
} from "#templates/admin/logistics.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { enableFeature } from "#test-utils/settings.ts";

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
    // The agent-details fieldset and the assigned-users fieldset carry their
    // exact classes.
    expect(html).toContain('<fieldset class="listing-section">');
    expect(html).toContain('class="checkboxes listing-section"');
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

describe("logisticsAgentPages delete page", () => {
  test("confirms the agent by name and posts to its delete path", () => {
    const html = logisticsAgentPages.deletePage(agent, session);
    expect(html).toContain('action="/admin/logistics/7/delete"');
    expect(html).toContain(
      "delete the logistics agent <strong>Van 1</strong>?",
    );
    expect(html).toContain("Type the agent name &quot;Van 1&quot; to confirm:");
  });

  test("renders the delete as a non-danger confirmation", () => {
    const html = logisticsAgentPages.deletePage(agent, session);
    // delete.danger is false, so the submit is the plain (check) button, not
    // the red danger one.
    expect(html).not.toContain('<button class="danger"');
  });
});

describe("logisticsAgentPages new page", () => {
  test("renders the add-agent form posting to the logistics base path", () => {
    const html = logisticsAgentPages.newPage(session);
    expect(html).toContain("Add Logistics Agent");
    expect(html).toContain("Create Agent");
    expect(html).toContain('action="/admin/logistics"');
    // A direct URL stays usable while the feature is hidden, without restoring
    // its navigation link.
    expect(html).not.toContain('<a class="active" href="/admin/logistics">');
  });
});

describeWithEnv("adminLogisticsPage", { db: true, encryptionKey: true }, () => {
  beforeEach(async () => {
    await signCsrfToken();
  });

  test("renders agent management and the guide without the old toggle", () => {
    const html = adminLogisticsPage([agent], session);

    expect(html).not.toContain('action="/admin/logistics/has-logistics"');
    expect(html).not.toContain('name="has_logistics"');
    expect(html).toContain('href="/admin/guide#logistics"');
    expect(html).toContain("Logistics guide");
    expect(html).toContain("Logistics Agents");
    expect(html).toContain('href="/admin/logistics/7/edit"');
  });

  test("renders a row per agent and marks enabled logistics active", async () => {
    await enableFeature("logistics");
    const html = adminLogisticsPage([agent], session);

    expect(html).toContain("Logistics Agents");
    expect(html).toContain("Agents (e.g. vans, drivers, or crew)");
    expect(html).toContain('href="/admin/logistics/7/edit"');
    expect(html).toContain("Van 1");
    // The inline add form, its section fieldset and the add (plus) button.
    expect(html).toContain('action="/admin/logistics"');
    expect(html).toContain('class="listing-section"');
    expect(html).toContain('href="/icons.svg#plus"');
    expect(html).toContain("Add Agent");
    // The page marks the logistics nav entry active.
    expect(html).toContain('<a class="active" href="/admin/logistics">');
    // A populated list shows the table, not the empty-state placeholder.
    expect(html).not.toContain("No logistics agents yet.");
  });

  test("shows the empty-state placeholder with no agents", () => {
    const html = adminLogisticsPage([], session);

    expect(html).toContain("Logistics Agents");
    expect(html).toContain("No logistics agents yet.");
    // No agent rows are rendered.
    expect(html).not.toContain('href="/admin/logistics/7/edit"');
  });
});
