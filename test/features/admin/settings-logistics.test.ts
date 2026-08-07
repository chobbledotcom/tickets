/** Direct unit tests for settings-logistics.ts — the logistics agent CRUD and
 *  edit route whose afterWrite persists agent-user assignments. Integration
 *  tests in test/integration/server/logistics.test.ts exercise the same routes
 *  through the server; these are the mirror for mutation testing. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { agentUsers } from "#shared/db/user-agents.ts";
import { getAllUsers } from "#shared/db/users.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createLogisticsAgent } from "#test-utils/db-helpers/logistics-agents.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("settings-logistics", { db: true }, () => {
  test("creates a logistics agent and shows it on the list page", async () => {
    const { response } = await adminFormPost("/admin/logistics", {
      name: "Mirror Van",
    });

    await expectFlashRedirect(
      "/admin/logistics",
      "Logistics agent created",
    )(response);
    const html = await (await adminGet("/admin/logistics")).text();
    expect(html).toContain("Mirror Van");
  });

  test("edits an agent and renames it", async () => {
    const id = await createLogisticsAgent("Rename Me");

    const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
      name: "Renamed",
    });

    await expectFlashRedirect(
      "/admin/logistics",
      "Logistics agent updated",
    )(response);
    expect((await logisticsAgents.table.read.one({ id }))!.name).toBe(
      "Renamed",
    );
  });

  test("the edit afterWrite persists assigned users", async () => {
    const id = await createLogisticsAgent("Assigned Van");
    const userId = (await getAllUsers())[0]!.id;

    const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
      name: "Assigned Van",
      user_ids: String(userId),
    });

    await expectFlashRedirect(
      "/admin/logistics",
      "Logistics agent updated",
    )(response);
    expect(await agentUsers.getIds(id)).toEqual([userId]);
  });

  test("the edit afterWrite drops unknown user ids", async () => {
    const id = await createLogisticsAgent("Unknown Id Van");

    await adminFormPost(`/admin/logistics/${id}/edit`, {
      name: "Unknown Id Van",
      user_ids: "99999",
    });

    expect(await agentUsers.getIds(id)).toEqual([]);
  });

  test("the edit form pre-checks assigned users", async () => {
    const id = await createLogisticsAgent("Pre-check Van");
    const userId = (await getAllUsers())[0]!.id;
    await adminFormPost(`/admin/logistics/${id}/edit`, {
      name: "Pre-check Van",
      user_ids: String(userId),
    });

    const html = await (await adminGet(`/admin/logistics/${id}`)).text();

    expect(html).toMatch(new RegExp(`checked[^>]*value="${userId}"`));
  });

  test("editing a missing agent returns 404", async () => {
    const { response } = await adminFormPost("/admin/logistics/99999/edit", {
      name: "Ghost",
    });

    expect(response.status).toBe(404);
  });

  test("deletes an agent and clears its references", async () => {
    const id = await createLogisticsAgent("Delete Me");
    const html = await (
      await adminGet(`/admin/logistics/${id}/actions`)
    ).text();
    expect(html).toContain(`/admin/logistics/${id}/delete`);

    const { response } = await adminFormPost(`/admin/logistics/${id}/delete`, {
      confirm_identifier: "Delete Me",
    });

    await expectFlashRedirect(
      "/admin/logistics",
      "Logistics agent deleted",
    )(response);
    expect(await logisticsAgents.table.read.one({ id })).toBeNull();
  });

  test("deleting an agent clears its user assignments", async () => {
    const id = await createLogisticsAgent("Clear Users Agent");
    const userId = (await getAllUsers())[0]!.id;
    await adminFormPost(`/admin/logistics/${id}/edit`, {
      name: "Clear Users Agent",
      user_ids: String(userId),
    });
    expect(await agentUsers.getIds(id)).toEqual([userId]);

    await adminFormPost(`/admin/logistics/${id}/delete`, {
      confirm_identifier: "Clear Users Agent",
    });

    expect(await agentUsers.getIds(id)).toEqual([]);
  });
});
