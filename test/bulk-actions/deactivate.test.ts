import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getEventWithCount } from "#shared/db/events.ts";
import {
  adminFormPost,
  adminGet,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("Admin bulk actions — deactivate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/deactivate", () => {
    test("renders the deactivate confirmation form with singular event count", async () => {
      const group = await createTestGroup({ name: "To Deactivate" });
      await createTestEvent({ groupId: group.id, name: "Event" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Deactivate Group");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("deactivate 1 active event");
      expect(html).not.toContain("deactivate 1 active events");
    });

    test("renders the deactivate form with plural event count", async () => {
      const group = await createTestGroup({ name: "Multi Deact" });
      await createTestEvent({ groupId: group.id, name: "A" });
      await createTestEvent({ groupId: group.id, name: "B" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("deactivate 2 active events");
    });

    test("returns 404 when the group does not exist", async () => {
      const { response } = await adminGet(
        "/admin/groups/999999/bulk-actions/deactivate",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/deactivate", () => {
    test("deactivates every event in the group when the name is confirmed", async () => {
      const group = await createTestGroup({ name: "Shutdown" });
      const a = await createTestEvent({ groupId: group.id, name: "A" });
      const b = await createTestEvent({ groupId: group.id, name: "B" });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Shutdown" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}`,
      );
      expect((await getEventWithCount(a.id))?.active).toBe(false);
      expect((await getEventWithCount(b.id))?.active).toBe(false);
    });

    test("rejects when the group name does not match and leaves events active", async () => {
      const group = await createTestGroup({ name: "Keep Active" });
      const event = await createTestEvent({
        groupId: group.id,
        name: "Event",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Wrong Name" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      expect((await getEventWithCount(event.id))?.active).toBe(true);
    });

    test("does not touch events outside the target group", async () => {
      const target = await createTestGroup({ name: "Target" });
      const other = await createTestGroup({ name: "Other" });
      await createTestEvent({ groupId: target.id, name: "Target Event" });
      const outsider = await createTestEvent({
        groupId: other.id,
        name: "Outsider Event",
      });

      await adminFormPost(
        `/admin/groups/${target.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Target" },
      );

      expect((await getEventWithCount(outsider.id))?.active).toBe(true);
    });
  });
});
