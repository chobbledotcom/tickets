import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { getLogisticsAssignments } from "#shared/db/logistics.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { agentUsers } from "#shared/db/user-agents.ts";
import { getAllUsers } from "#shared/db/users.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingWithAttendeeAndLogistics } from "#test-utils/db-helpers/attendee-payments.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest, withExpectedError } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
} from "#test-utils/session.ts";
import { enableFeature, storedFeatureEnabled } from "#test-utils/settings.ts";

const createAgent = async (name: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/logistics", { name });
  expect(response.status).toBe(302);
  const agents = await logisticsAgents.getAll();
  return agents.find((a) => a.name === name)!.id;
};

/** Create a listing + attendee pair and assign logistics agents to the
 *  booking line. Delegates to the shared `createListingWithAttendeeAndLogistics`
 *  so both the runsheet and server-logistics tests build the same fixture. */
const createBookingWithAgent = async (
  agentId: number,
): Promise<{ attendeeId: number; listingId: number }> =>
  createListingWithAttendeeAndLogistics(
    (id) =>
      new Map([
        [
          id,
          {
            endAgentId: agentId,
            endTime: "",
            startAgentId: agentId,
            startTime: "",
          },
        ],
      ]),
  );

describeWithEnv("server (admin logistics)", { db: true }, () => {
  describe("GET /admin/logistics", () => {
    testRequiresAuth("/admin/logistics");

    test("shows logistics agent management", async () => {
      const response = await adminGet("/admin/logistics");
      await expectHtmlResponse(response, 200, "Logistics", "Logistics Agents");
    });

    test("nav hides Logistics until the feature is enabled", async () => {
      const body = await (await adminGet("/admin/logistics")).text();
      expect(body).not.toContain('class="active" href="/admin/logistics"');
      await enableFeature("logistics");
      const enabledBody = await (await adminGet("/admin/logistics")).text();
      expect(enabledBody).toContain('class="active" href="/admin/logistics"');
    });

    test("highlights the Logistics sub-nav link on the logistics page", async () => {
      // Regression: the main /admin/logistics page used the admin-page helper's
      // default active route (/admin/settings), so the Logistics sub-nav link
      // never lit up on the page users actually land on.
      await enableFeature("logistics");
      const body = await (await adminGet("/admin/logistics")).text();
      expect(body).toContain('class="active" href="/admin/logistics"');
    });
  });

  describe("logistics agent CRUD", () => {
    test("creates an agent and lists it", async () => {
      const { response } = await adminFormPost("/admin/logistics", {
        name: "Van 1",
      });
      await expectFlashRedirect(
        "/admin/logistics",
        "Logistics agent created",
      )(response);
      const list = await adminGet("/admin/logistics");
      await expectHtmlResponse(list, 200, "Van 1", "/admin/logistics/");
      expect(await storedFeatureEnabled("logistics")).toBe(true);
    });

    test("does not assign users through a crafted create form", async () => {
      const userId = (await getAllUsers())[0]!.id;
      const { response } = await adminFormPost("/admin/logistics", {
        name: "Unassigned van",
        user_ids: String(userId),
      });
      expect(response.status).toBe(302);
      const id = (await logisticsAgents.getAll()).find(
        (agent) => agent.name === "Unassigned van",
      )!.id;
      expect(await agentUsers.getIds(id)).toEqual([]);
    });

    test("rejects an empty agent name", async () => {
      const { response } = await adminFormPost("/admin/logistics", {
        name: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("GET /admin/logistics/new renders the standalone form", async () => {
      const response = await adminGet("/admin/logistics/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Logistics Agent",
        "Agent Name",
      );
    });

    test("edits an agent", async () => {
      const id = await createAgent("Van A");
      const editForm = await adminGet(`/admin/logistics/${id}`);
      const editHtml = await editForm.text();
      // The form must post to the real edit route (no stray /agents/ segment).
      expect(editHtml).toContain(`action="/admin/logistics/${id}/edit"`);
      expect(editHtml).toContain(`href="/admin/logistics/${id}"`);
      expect(editHtml).toContain(`href="/admin/logistics/${id}/actions"`);
      expect(editHtml).toContain("Van A");
      expect(editHtml).not.toContain(`/admin/logistics/${id}/delete`);
      const actionsHtml = await (
        await adminGet(`/admin/logistics/${id}/actions`)
      ).text();
      expect(actionsHtml).toContain(`/admin/logistics/${id}/delete`);
      const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "Van B",
      });
      await expectFlashRedirect(
        "/admin/logistics",
        "Logistics agent updated",
      )(response);
      const agents = await logisticsAgents.getAll();
      expect(agents.find((a) => a.id === id)!.name).toBe("Van B");
    });

    test("assigns users to an agent, drops unknown ids, and pre-checks them", async () => {
      const id = await createAgent("Crewed Van");
      const userId = (await getAllUsers())[0]!.id;

      // Assigning a real user persists the link.
      const assigned = await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "Crewed Van",
        user_ids: String(userId),
      });
      await expectFlashRedirect(
        "/admin/logistics",
        "Logistics agent updated",
      )(assigned.response);
      expect(await agentUsers.getIds(id)).toEqual([userId]);

      // The edit form pre-checks the assigned user.
      const editHtml = await (await adminGet(`/admin/logistics/${id}`)).text();
      expect(editHtml).toMatch(new RegExp(`checked[^>]*value="${userId}"`));

      // Submitting an unknown user id clears the links (it is dropped).
      await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "Crewed Van",
        user_ids: "999999",
      });
      expect(await agentUsers.getIds(id)).toEqual([]);
    });

    test("rolls back the name when assigned-user writes fail", async () => {
      const id = await createAgent("Atomic van");
      const userId = (await getAllUsers())[0]!.id;
      await getDb().execute(`
        CREATE TRIGGER fail_agent_user_link
        BEFORE INSERT ON user_logistics_agents
        BEGIN
          SELECT RAISE(ABORT, 'agent user link failed');
        END
      `);

      const response = await withExpectedError(
        async () =>
          (
            await adminFormPost(`/admin/logistics/${id}/edit`, {
              name: "Partly saved van",
              user_ids: String(userId),
            })
          ).response,
      );

      expect(response.status).toBe(503);
      expect((await logisticsAgents.table.read.one({ id: id }))!.name).toBe(
        "Atomic van",
      );
      expect(await agentUsers.getIds(id)).toEqual([]);
    });

    test("does not offer or accept editors as logistics drivers", async () => {
      const id = await createAgent("No Editors Van");
      const { userId: agentUserId } = await createTestAgentSession({
        username: "drivableagent",
      });
      const { userId: editorUserId } = await createTestEditorSession({
        username: "noteditordriver",
      });

      // The edit form offers the agent user but never the editor.
      const editHtml = await (await adminGet(`/admin/logistics/${id}`)).text();
      expect(editHtml).toContain(`value="${agentUserId}"`);
      expect(editHtml).not.toContain(`value="${editorUserId}"`);

      // A crafted submission with the editor's id is dropped server-side.
      await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "No Editors Van",
        user_ids: String(editorUserId),
      });
      expect(await agentUsers.getIds(id)).toEqual([]);
    });

    test("shows a delete confirmation and deletes the agent", async () => {
      const id = await createAgent("Doomed Van");
      const confirm = await adminGet(`/admin/logistics/${id}/delete`);
      const confirmHtml = await confirm.text();
      expect(confirmHtml).toContain(`action="/admin/logistics/${id}/delete"`);
      expect(confirmHtml).toContain("Delete Logistics Agent");
      expect(confirmHtml).toContain("Doomed Van");
      const { response } = await adminFormPost(
        `/admin/logistics/${id}/delete`,
        {
          confirm_identifier: "Doomed Van",
        },
      );
      await expectFlashRedirect(
        "/admin/logistics",
        "Logistics agent deleted",
      )(response);
      expect(await logisticsAgents.table.read.one({ id: id })).toBeNull();
    });

    test("deleting an agent clears its booking references", async () => {
      const id = await createAgent("Assigned Van");
      const { attendeeId, listingId } = await createBookingWithAgent(id);

      await adminFormPost(`/admin/logistics/${id}/delete`, {
        confirm_identifier: "Assigned Van",
      });

      const got = await getLogisticsAssignments(attendeeId);
      expect(got.get(listingId)).toEqual({
        endAgentId: null,
        endTime: "",
        startAgentId: null,
        startTime: "",
      });
    });

    test("returns 404 editing a missing agent", async () => {
      const response = await adminGet("/admin/logistics/999");
      expectStatus(404)(response);
    });

    test("returns 404 posting an edit to a missing agent", async () => {
      const { response } = await adminFormPost("/admin/logistics/999/edit", {
        name: "Ghost Van",
      });
      expectStatus(404)(response);
    });

    test("rejects an empty name in place with submitted assignments", async () => {
      const id = await createAgent("Keep Me");
      const userId = (await getAllUsers())[0]!.id;
      const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "   ",
        user_ids: String(userId),
      });
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("Agent Name is required");
      expect(body).toMatch(
        new RegExp(
          `checked[^>]*value="${userId}"|value="${userId}"[^>]*checked`,
        ),
      );
      const kept = (await logisticsAgents.getAll()).find((a) => a.id === id);
      expect(kept!.name).toBe("Keep Me");
      expect(await agentUsers.getIds(id)).toEqual([]);
    });

    test("keeps edit and actions unavailable in read-only mode", async () => {
      const id = await createAgent("Read only van");
      using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });

      expectStatus(404)(await adminGet(`/admin/logistics/${id}`));
      expectStatus(404)(await adminGet(`/admin/logistics/${id}/actions`));
    });

    test("keeps the entity page owner-only", async () => {
      const id = await createAgent("Owner van");
      const response = await awaitTestRequest(`/admin/logistics/${id}`, {
        cookie: await createTestManagerSession("logistics-manager"),
      });
      expectStatus(403)(response);
    });
  });
});
