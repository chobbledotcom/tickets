import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { eventsTable, getEventWithCount } from "#shared/db/events.ts";
import {
  adminFormPost,
  adminGet,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("Admin bulk actions — reactivate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/reactivate", () => {
    test("renders the reactivate confirmation form with a singular event count", async () => {
      const group = await createTestGroup({ name: "Solo Off" });
      const event = await createTestEvent({
        groupId: group.id,
        name: "Only",
      });
      await eventsTable.update(event.id, { active: false });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Reactivate Group");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("reactivate 1 event");
      expect(html).not.toContain("reactivate 1 events");
    });

    test("renders the reactivate form with a plural event count", async () => {
      const group = await createTestGroup({ name: "Many Off" });
      const a = await createTestEvent({ groupId: group.id, name: "A" });
      const b = await createTestEvent({ groupId: group.id, name: "B" });
      await eventsTable.update(a.id, { active: false });
      await eventsTable.update(b.id, { active: false });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("reactivate 2 events");
    });

    test("returns 404 when the group does not exist", async () => {
      const { response } = await adminGet(
        "/admin/groups/999999/bulk-actions/reactivate",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/reactivate", () => {
    test("reactivates every event in the group when the name is confirmed", async () => {
      const group = await createTestGroup({ name: "Bring Back" });
      const a = await createTestEvent({ groupId: group.id, name: "A" });
      const b = await createTestEvent({ groupId: group.id, name: "B" });
      await eventsTable.update(a.id, { active: false });
      await eventsTable.update(b.id, { active: false });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
        { confirm_identifier: "Bring Back" },
      );

      expect(response.status).toBe(302);
      expect((await getEventWithCount(a.id))?.active).toBe(true);
      expect((await getEventWithCount(b.id))?.active).toBe(true);
    });

    test("rejects when the group name does not match and leaves events inactive", async () => {
      const group = await createTestGroup({ name: "Stay Off" });
      const event = await createTestEvent({
        groupId: group.id,
        name: "Event",
      });
      await eventsTable.update(event.id, { active: false });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
        { confirm_identifier: "Different" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
      expect((await getEventWithCount(event.id))?.active).toBe(false);
    });
  });
});
