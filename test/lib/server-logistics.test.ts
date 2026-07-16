import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
import {
  adminFormPost,
  adminGet,
  createTestAgentSession,
  createTestEditorSession,
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
      // The agent name links to its edit page; delete lives on that page now.
      await expectHtmlResponse(list, 200, "Van 1", "/edit");
      expect(await storedFeatureEnabled("logistics")).toBe(true);
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
      const editForm = await adminGet(`/admin/logistics/${id}/edit`);
      const editHtml = await editForm.text();
      // The form must post to the real edit route (no stray /agents/ segment).
      expect(editHtml).toContain(`action="/admin/logistics/${id}/edit"`);
      expect(editHtml).toContain("Edit Logistics Agent");
      expect(editHtml).toContain("Van A");
      // Delete moved off the agents list onto the edit page.
      expect(editHtml).toContain(`/admin/logistics/${id}/delete`);
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
      const editHtml = await (
        await adminGet(`/admin/logistics/${id}/edit`)
      ).text();
      expect(editHtml).toMatch(new RegExp(`checked[^>]*value="${userId}"`));

      // Submitting an unknown user id clears the links (it is dropped).
      await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "Crewed Van",
        user_ids: "999999",
      });
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
      const editHtml = await (
        await adminGet(`/admin/logistics/${id}/edit`)
      ).text();
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
      expect(await logisticsAgents.table.findById(id)).toBeNull();
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
      const response = await adminGet("/admin/logistics/999/edit");
      expectStatus(404)(response);
    });

    test("returns 404 posting an edit to a missing agent", async () => {
      const { response } = await adminFormPost("/admin/logistics/999/edit", {
        name: "Ghost Van",
      });
      expectStatus(404)(response);
    });

    test("rejects an empty name on edit, keeping the old name", async () => {
      const id = await createAgent("Keep Me");
      const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "   ",
      });
      await expectFlashRedirect(
        `/admin/logistics/${id}/edit`,
        "Agent Name is required",
        false,
      )(response);
      const kept = (await logisticsAgents.getAll()).find((a) => a.id === id);
      expect(kept!.name).toBe("Keep Me");
    });
  });
});
