import { expect } from "@std/expect";
import { beforeAll, beforeEach, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { LogisticsAgent } from "#shared/types.ts";
import {
  type AgentUserOption,
  adminLogisticsPage,
  LogisticsAgentEditPanel,
  logisticsAgentPages,
} from "#templates/admin/logistics.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { enableFeature } from "#test-utils/settings.ts";

const agent: LogisticsAgent = { id: 7, name: "Van 1" };

const users: AgentUserOption[] = [
  { adminLevel: "agent", id: 1, username: "driver" },
  { adminLevel: "manager", id: 2, username: "boss" },
];

describe("LogisticsAgentEditPanel", () => {
  beforeAll(setupAdminPageTest);

  const renderPanel = (
    selectedUserIds: ReadonlySet<number> = new Set(),
  ): string =>
    String(LogisticsAgentEditPanel({ agent, selectedUserIds, users }));

  test("groups the form into agent-details and assigned-users fieldsets", () => {
    const html = renderPanel();
    expect(html).toContain("<legend>Agent details</legend>");
    expect(html).toContain("<legend>Assigned users</legend>");
    expect(html).toContain("Van 1");
    // The agent-details fieldset and the assigned-users fieldset carry their
    // exact classes.
    expect(html).toContain('<fieldset class="listing-section">');
    expect(html).toContain('class="checkboxes listing-section"');
  });

  test("explains that agent-class users only see the deliveries page", () => {
    const html = renderPanel();
    expect(html).toContain(
      "Agent-class users can only see the deliveries page",
    );
  });

  test("lists every user class as an assignable checkbox", () => {
    const html = renderPanel();
    expect(html).toContain('name="user_ids"');
    expect(html).toContain("driver (agent)");
    expect(html).toContain("boss (manager)");
  });

  test("pre-checks the users already assigned to the agent", () => {
    const html = renderPanel(new Set([2]));
    // The assigned user's checkbox is checked; the unassigned one is not.
    expect(html).toMatch(/value="2"[^>]*checked|checked[^>]*value="2"/);
    expect(html).not.toMatch(/value="1"[^>]*checked|checked[^>]*value="1"/);
  });

  test("shows a placeholder when there are no users to assign", () => {
    const html = String(
      LogisticsAgentEditPanel({
        agent,
        selectedUserIds: new Set(),
        users: [],
      }),
    );
    expect(html).toContain("No users to assign yet.");
  });

  test("renders submitted values and an error", () => {
    const html = String(
      LogisticsAgentEditPanel({
        agent,
        error: "Agent name is required",
        selectedUserIds: new Set([1]),
        users,
        values: { name: "Submitted van" },
      }),
    );
    expect(html).toContain('value="Submitted van"');
    expect(html).toContain("Agent name is required");
    expect(html).toMatch(/value="1"[^>]*checked|checked[^>]*value="1"/);
  });
});

describe("logisticsAgentPages delete page", () => {
  beforeAll(setupAdminPageTest);

  test("confirms the agent by name and posts to its delete path", () => {
    const html = logisticsAgentPages.deletePage(agent, OWNER_SESSION);
    expect(html).toContain('action="/admin/logistics/7/delete"');
    expect(html).toContain(
      "delete the logistics agent <strong>Van 1</strong>?",
    );
    expect(html).toContain("Type the agent name &quot;Van 1&quot; to confirm:");
  });

  test("renders the delete as a non-danger confirmation", () => {
    const html = logisticsAgentPages.deletePage(agent, OWNER_SESSION);
    // delete.danger is false, so the submit is the plain (check) button, not
    // the red danger one.
    expect(html).not.toContain('<button class="danger"');
  });
});

describe("logisticsAgentPages new page", () => {
  beforeAll(setupAdminPageTest);

  test("renders the add-agent form posting to the logistics base path", () => {
    const html = logisticsAgentPages.newPage(OWNER_SESSION);
    expect(html).toContain("Add logistics agent");
    expect(html).toContain("Create agent");
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
    const html = adminLogisticsPage([agent], OWNER_SESSION);

    expect(html).not.toContain('action="/admin/logistics/has-logistics"');
    expect(html).not.toContain('name="has_logistics"');
    expect(html).toContain('href="/admin/guide#logistics"');
    expect(html).toContain("Logistics guide");
    expect(html).toContain("Logistics Agents");
    expect(html).toContain('href="/admin/logistics/7"');
  });

  test("renders a row per agent and marks enabled logistics active", async () => {
    await enableFeature("logistics");
    const html = adminLogisticsPage([agent], OWNER_SESSION);

    expect(html).toContain("Logistics Agents");
    expect(html).toContain("Agents (e.g. vans, drivers, or crew)");
    expect(html).toContain('href="/admin/logistics/7"');
    expect(html).toContain("Van 1");
    // The inline add form, its section fieldset and the add (plus) button.
    expect(html).toContain('action="/admin/logistics"');
    expect(html).toContain('class="listing-section"');
    expect(html).toContain('href="/icons.svg#plus"');
    expect(html).toContain("Add agent");
    // The page marks the logistics nav entry active.
    expect(html).toContain('<a class="active" href="/admin/logistics">');
    // A populated list shows the table, not the empty-state placeholder.
    expect(html).not.toContain("No logistics agents yet.");
  });

  test("shows the empty-state placeholder with no agents", () => {
    const html = adminLogisticsPage([], OWNER_SESSION);

    expect(html).toContain("Logistics Agents");
    expect(html).toContain("No logistics agents yet.");
    // No agent rows are rendered.
    expect(html).not.toContain('href="/admin/logistics/7"');
  });
});
