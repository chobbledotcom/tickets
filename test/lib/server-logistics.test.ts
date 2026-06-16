import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getLogisticsAssignments,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import {
  getAllLogisticsAgents,
  logisticsAgentsTable,
} from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  adminGet,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  expectStatus,
  testRequiresAuth,
} from "#test-utils";

const createAgent = async (name: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/logistics", { name });
  expect(response.status).toBe(302);
  const agents = await getAllLogisticsAgents();
  return agents.find((a) => a.name === name)!.id;
};

describeWithEnv("server (admin logistics)", { db: true }, () => {
  describe("GET /admin/logistics", () => {
    testRequiresAuth("/admin/logistics");

    test("shows the logistics toggle, hiding agents when disabled", async () => {
      const { response } = await adminGet("/admin/logistics");
      await expectHtmlResponse(response, 200, "Logistics", "has_logistics");
      const body = await (await adminGet("/admin/logistics")).response.text();
      expect(body).not.toContain("Logistics Agents");
    });

    test("shows the agents section when logistics is enabled", async () => {
      settings.setForTest({ has_logistics: true });
      const { response } = await adminGet("/admin/logistics");
      await expectHtmlResponse(response, 200, "Logistics Agents", "Add Agent");
    });

    test("nav shows a Logistics link for owners", async () => {
      const body = await (await adminGet("/admin/logistics")).response.text();
      expect(body).toContain('href="/admin/logistics"');
      expect(body).toContain(">Logistics<");
    });
  });

  describe("POST /admin/logistics/has-logistics", () => {
    testRequiresAuth("/admin/logistics/has-logistics", {
      body: { has_logistics: "true" },
      method: "POST",
    });

    test("enabling persists and reveals the agents section", async () => {
      const { response } = await adminFormPost(
        "/admin/logistics/has-logistics",
        {
          has_logistics: "true",
        },
      );
      expectRedirectWithFlash(
        "/admin/logistics",
        "Logistics enabled",
      )(response);
      const body = await (await adminGet("/admin/logistics")).response.text();
      expect(body).toContain("Logistics Agents");
    });

    test("disabling reports it", async () => {
      const { response } = await adminFormPost(
        "/admin/logistics/has-logistics",
        {
          has_logistics: "false",
        },
      );
      expectRedirectWithFlash(
        "/admin/logistics",
        "Logistics disabled",
      )(response);
    });
  });

  describe("logistics agent CRUD", () => {
    test("creates an agent and lists it", async () => {
      settings.setForTest({ has_logistics: true });
      const { response } = await adminFormPost("/admin/logistics", {
        name: "Van 1",
      });
      expectRedirectWithFlash(
        "/admin/logistics",
        "Logistics agent created",
      )(response);
      const list = await adminGet("/admin/logistics");
      await expectHtmlResponse(list.response, 200, "Van 1", "/edit", "/delete");
    });

    test("rejects an empty agent name", async () => {
      const { response } = await adminFormPost("/admin/logistics", {
        name: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("GET /admin/logistics/new renders the standalone form", async () => {
      const { response } = await adminGet("/admin/logistics/new");
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
      const editHtml = await editForm.response.text();
      // The form must post to the real edit route (no stray /agents/ segment).
      expect(editHtml).toContain(`action="/admin/logistics/${id}/edit"`);
      expect(editHtml).toContain("Edit Logistics Agent");
      expect(editHtml).toContain("Van A");
      const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
        name: "Van B",
      });
      expectRedirectWithFlash(
        "/admin/logistics",
        "Logistics agent updated",
      )(response);
      const agents = await getAllLogisticsAgents();
      expect(agents.find((a) => a.id === id)!.name).toBe("Van B");
    });

    test("shows a delete confirmation and deletes the agent", async () => {
      const id = await createAgent("Doomed Van");
      const confirm = await adminGet(`/admin/logistics/${id}/delete`);
      const confirmHtml = await confirm.response.text();
      expect(confirmHtml).toContain(`action="/admin/logistics/${id}/delete"`);
      expect(confirmHtml).toContain("Delete Logistics Agent");
      expect(confirmHtml).toContain("Doomed Van");
      const { response } = await adminFormPost(
        `/admin/logistics/${id}/delete`,
        {
          confirm_identifier: "Doomed Van",
        },
      );
      expectRedirectWithFlash(
        "/admin/logistics",
        "Logistics agent deleted",
      )(response);
      expect(await logisticsAgentsTable.findById(id)).toBeNull();
    });

    test("deleting an agent clears its booking references", async () => {
      const id = await createAgent("Assigned Van");
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Cust",
        "c@example.com",
      );
      await setLogisticsAssignments(
        attendee.id,
        false,
        new Map([[listing.id, { endAgentId: id, startAgentId: id }]]),
      );

      await adminFormPost(`/admin/logistics/${id}/delete`, {
        confirm_identifier: "Assigned Van",
      });

      const got = await getLogisticsAssignments(attendee.id);
      expect(got.get(listing.id)).toEqual({
        endAgentId: null,
        startAgentId: null,
      });
    });

    test("returns 404 editing a missing agent", async () => {
      const { response } = await adminGet("/admin/logistics/999/edit");
      expectStatus(404)(response);
    });
  });
});
