/**
 * The logistics-agent record page: the owner-only Edit and Actions surface
 * under /admin/logistics/:id, and the user list its edit tab offers. Only a
 * user who can drive may be assigned, so that filter is checked directly.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadAgentUserOptions } from "#routes/admin/logistics-agent-page.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { createLogisticsAgent } from "#test-utils/db-helpers/logistics-agents.ts";
import { has, says } from "#test-utils/says.ts";
import {
  adminFormPost,
  adminGet,
  createTestAgentSession,
  createTestEditorSession,
} from "#test-utils/session.ts";

describeWithEnv("the logistics agent page", { db: true }, () => {
  test("opens on the edit form for the agent named in the path", async () => {
    const id = await createLogisticsAgent("Blue Van");

    const response = await adminGet(`/admin/logistics/${id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    says(html, `action="/admin/logistics/${id}/edit"`);
    says(html, "Blue Van");
  });

  test("opens on the edit tab and highlights the section it sits in", async () => {
    // Logistics is a link under Settings rather than a section of its own, so
    // the top-level link that lights up is Settings.
    const id = await createLogisticsAgent("Red Van");

    const html = await (await adminGet(`/admin/logistics/${id}`)).text();

    says(html, `<a class="active" href="/admin/settings">`);
    says(
      html,
      `<a aria-current="page" class="active" href="/admin/logistics/${id}">Edit</a>`,
    );
  });

  test("offers deleting the agent on its actions tab", async () => {
    const id = await createLogisticsAgent("Spare Van");

    const response = await adminGet(`/admin/logistics/${id}/actions`);
    const html = await response.text();

    expect(response.status).toBe(200);
    says(html, `href="/admin/logistics/${id}/delete"`);
  });

  test("keeps the drivers that were ticked when the edit is refused", async () => {
    const id = await createLogisticsAgent("Refused Van");
    const { userId } = await createTestAgentSession({ username: "keptdriver" });

    const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
      name: "",
      user_ids: [String(userId)],
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    says(html, `checked name="user_ids"`);
    says(html, `value="${userId}"`);
  });

  test("answers 404 for an agent that is not there", async () => {
    expect((await adminGet("/admin/logistics/99999")).status).toBe(404);
  });

  test("offers only users who may drive", async () => {
    await createTestAgentSession({ username: "driver" });
    await createTestEditorSession();

    const options = await loadAgentUserOptions();

    has(
      options.map((option) => option.username),
      "driver",
    );
    expect(options.every((option) => option.adminLevel !== "editor")).toBe(
      true,
    );
  });
});
