import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, beforeEach, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
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
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { enableFeature } from "#test-utils/settings.ts";
import type { LogisticsAgent } from "#types";

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
    expectIncludesAll(html, [
      "<legend>Agent details</legend>",
      "<legend>Assigned users</legend>",
      "Van 1",
      // The agent-details fieldset and the assigned-users fieldset carry their
      // exact classes.
      '<fieldset class="listing-section">',
      'class="checkboxes listing-section"',
    ]);
  });

  test("explains that agent-class users only see the deliveries page", () => {
    const html = renderPanel();
    assertStringIncludes(
      html,
      "Agent-class users can only see the deliveries page",
    );
  });

  test("lists every user class as an assignable checkbox", () => {
    const html = renderPanel();
    expectIncludesAll(html, [
      'name="user_ids"',
      "driver (agent)",
      "boss (manager)",
    ]);
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
    assertStringIncludes(html, "No users to assign yet.");
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
    expectIncludesAll(html, [
      'value="Submitted van"',
      "Agent name is required",
    ]);
    expect(html).toMatch(/value="1"[^>]*checked|checked[^>]*value="1"/);
  });
});

describe("logisticsAgentPages delete page", () => {
  beforeAll(setupAdminPageTest);

  test("confirms the agent by name and posts to its delete path", () => {
    const html = logisticsAgentPages.deletePage(agent, OWNER_SESSION);
    expectIncludesAll(html, [
      'action="/admin/logistics/7/delete"',
      "delete the logistics agent <strong>Van 1</strong>?",
      "Type the agent name &quot;Van 1&quot; to confirm:",
    ]);
  });

  test("renders the delete as a non-danger confirmation", () => {
    const html = logisticsAgentPages.deletePage(agent, OWNER_SESSION);
    // delete.danger is false, so the submit is the plain (check) button, not
    // the red danger one.
    assert(!html.includes('<button class="danger"'));
  });
});

describe("logisticsAgentPages new page", () => {
  beforeAll(setupAdminPageTest);

  test("renders the add-agent form posting to the logistics base path", () => {
    const html = logisticsAgentPages.newPage(OWNER_SESSION);
    expectIncludesAll(html, [
      "Add logistics agent",
      "Create agent",
      'action="/admin/logistics"',
    ]);
    // A direct URL stays usable while the feature is hidden, without restoring
    // its navigation link.
    assert(!html.includes('<a class="active" href="/admin/logistics">'));
  });
});

describeWithEnv("adminLogisticsPage", { db: true, encryptionKey: true }, () => {
  beforeEach(async () => {
    await signCsrfToken();
  });

  test("renders agent management and the guide without the old toggle", () => {
    const html = adminLogisticsPage([agent], OWNER_SESSION);

    assert(!html.includes('action="/admin/logistics/has-logistics"'));
    assert(!html.includes('name="has_logistics"'));
    expectIncludesAll(html, [
      'href="/admin/guide#logistics"',
      "Logistics guide",
      "Logistics agents",
      'href="/admin/logistics/7"',
    ]);
  });

  test("renders a row per agent and marks enabled logistics active", async () => {
    await enableFeature("logistics");
    const html = adminLogisticsPage([agent], OWNER_SESSION);

    expectIncludesAll(html, [
      "Logistics agents",
      "Agents (e.g. vans, drivers, or crew)",
      'href="/admin/logistics/7"',
      "Van 1",
      // The inline add form, its section fieldset and the add (plus) button.
      'action="/admin/logistics"',
      'class="listing-section"',
      'href="/icons.svg#plus"',
      "Add agent",
      // The page marks the logistics nav entry active.
      '<a class="active" href="/admin/logistics">',
    ]);
    // A populated list shows the table, not the empty-state placeholder.
    assert(!html.includes("No logistics agents yet."));
  });

  test("shows the empty-state placeholder with no agents", () => {
    const html = adminLogisticsPage([], OWNER_SESSION);

    expectIncludesAll(html, ["Logistics agents", "No logistics agents yet."]);
    // No agent rows are rendered.
    assert(!html.includes('href="/admin/logistics/7"'));
  });
});
