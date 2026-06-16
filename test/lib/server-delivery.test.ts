import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getDeliveryAssignments,
  setDeliveryAssignments,
} from "#shared/db/delivery.ts";
import {
  deliveryAgentsTable,
  getAllDeliveryAgents,
} from "#shared/db/delivery-agents.ts";
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
  const { response } = await adminFormPost("/admin/delivery", { name });
  expect(response.status).toBe(302);
  const agents = await getAllDeliveryAgents();
  return agents.find((a) => a.name === name)!.id;
};

describeWithEnv("server (admin delivery)", { db: true }, () => {
  describe("GET /admin/delivery", () => {
    testRequiresAuth("/admin/delivery");

    test("shows the delivery toggle, hiding agents when disabled", async () => {
      const { response } = await adminGet("/admin/delivery");
      await expectHtmlResponse(response, 200, "Delivery", "has_delivery");
      const body = await (await adminGet("/admin/delivery")).response.text();
      expect(body).not.toContain("Delivery Agents");
    });

    test("shows the agents section when delivery is enabled", async () => {
      settings.setForTest({ has_delivery: true });
      const { response } = await adminGet("/admin/delivery");
      await expectHtmlResponse(response, 200, "Delivery Agents", "Add Agent");
    });

    test("nav shows a Delivery link for owners", async () => {
      const body = await (await adminGet("/admin/delivery")).response.text();
      expect(body).toContain('href="/admin/delivery"');
      expect(body).toContain(">Delivery<");
    });
  });

  describe("POST /admin/delivery/has-delivery", () => {
    testRequiresAuth("/admin/delivery/has-delivery", {
      body: { has_delivery: "true" },
      method: "POST",
    });

    test("enabling persists and reveals the agents section", async () => {
      const { response } = await adminFormPost("/admin/delivery/has-delivery", {
        has_delivery: "true",
      });
      expectRedirectWithFlash("/admin/delivery", "Delivery enabled")(response);
      const body = await (await adminGet("/admin/delivery")).response.text();
      expect(body).toContain("Delivery Agents");
    });

    test("disabling reports it", async () => {
      const { response } = await adminFormPost("/admin/delivery/has-delivery", {
        has_delivery: "false",
      });
      expectRedirectWithFlash("/admin/delivery", "Delivery disabled")(response);
    });
  });

  describe("delivery agent CRUD", () => {
    test("creates an agent and lists it", async () => {
      settings.setForTest({ has_delivery: true });
      const { response } = await adminFormPost("/admin/delivery", {
        name: "Van 1",
      });
      expectRedirectWithFlash(
        "/admin/delivery",
        "Delivery agent created",
      )(response);
      const list = await adminGet("/admin/delivery");
      await expectHtmlResponse(list.response, 200, "Van 1", "/edit", "/delete");
    });

    test("rejects an empty agent name", async () => {
      const { response } = await adminFormPost("/admin/delivery", { name: "" });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("GET /admin/delivery/new renders the standalone form", async () => {
      const { response } = await adminGet("/admin/delivery/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Delivery Agent",
        "Agent Name",
      );
    });

    test("edits an agent", async () => {
      const id = await createAgent("Van A");
      const editForm = await adminGet(`/admin/delivery/${id}/edit`);
      await expectHtmlResponse(
        editForm.response,
        200,
        "Edit Delivery Agent",
        "Van A",
      );
      const { response } = await adminFormPost(`/admin/delivery/${id}/edit`, {
        name: "Van B",
      });
      expectRedirectWithFlash(
        "/admin/delivery",
        "Delivery agent updated",
      )(response);
      const agents = await getAllDeliveryAgents();
      expect(agents.find((a) => a.id === id)!.name).toBe("Van B");
    });

    test("shows a delete confirmation and deletes the agent", async () => {
      const id = await createAgent("Doomed Van");
      const confirm = await adminGet(`/admin/delivery/${id}/delete`);
      await expectHtmlResponse(
        confirm.response,
        200,
        "Delete Delivery Agent",
        "Doomed Van",
      );
      const { response } = await adminFormPost(`/admin/delivery/${id}/delete`, {
        confirm_identifier: "Doomed Van",
      });
      expectRedirectWithFlash(
        "/admin/delivery",
        "Delivery agent deleted",
      )(response);
      expect(await deliveryAgentsTable.findById(id)).toBeNull();
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
      await setDeliveryAssignments(
        attendee.id,
        false,
        new Map([[listing.id, { collectionAgentId: id, dropOffAgentId: id }]]),
      );

      await adminFormPost(`/admin/delivery/${id}/delete`, {
        confirm_identifier: "Assigned Van",
      });

      const got = await getDeliveryAssignments(attendee.id);
      expect(got.get(listing.id)).toEqual({
        collectionAgentId: null,
        dropOffAgentId: null,
      });
    });

    test("returns 404 editing a missing agent", async () => {
      const { response } = await adminGet("/admin/delivery/999/edit");
      expectStatus(404)(response);
    });
  });
});
