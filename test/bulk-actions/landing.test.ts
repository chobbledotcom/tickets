import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { eventsTable } from "#lib/db/events.ts";
import { handleRequest } from "#routes";
import {
  adminGet,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

describeWithEnv("Admin bulk actions landing page", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions", () => {
    test("renders the bulk-actions landing page with a duplicate link", async () => {
      const group = await createTestGroup({ name: "My Group" });
      await createTestEvent({ groupId: group.id, name: "Event A" });
      await createTestEvent({ groupId: group.id, name: "Event B" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Bulk Actions");
      expect(html).toContain("Duplicate Group");
      expect(html).toContain(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      // Plural noun is used when the group has multiple events.
      expect(html).toContain("all 2 events");
    });

    test("uses singular 'event' when the group has exactly one", async () => {
      const group = await createTestGroup({ name: "Solo Group" });
      await createTestEvent({ groupId: group.id, name: "Only Event" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).toContain("all 1 event");
      // Guard against the plural-suffix "events" slipping through
      expect(html).not.toContain("1 events");
    });

    test("returns 404 for a non-existent group", async () => {
      const { response } = await adminGet("/admin/groups/999999/bulk-actions");
      expect(response.status).toBe(404);
    });

    test("redirects to login when unauthenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/groups/1/bulk-actions"),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/groups/:id/bulk-actions — conditional links", () => {
    test("shows deactivate link and hides reactivate when all events are active", async () => {
      const group = await createTestGroup({ name: "All Active" });
      await createTestEvent({ groupId: group.id, name: "Active Event" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
    });

    test("shows reactivate link and hides deactivate when all events are deactivated", async () => {
      const group = await createTestGroup({ name: "All Off" });
      const event = await createTestEvent({
        groupId: group.id,
        name: "Off Event",
      });
      await eventsTable.update(event.id, { active: false });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
    });

    test("shows only deactivate link when group is mixed (some active, some inactive)", async () => {
      const group = await createTestGroup({ name: "Mixed" });
      await createTestEvent({ groupId: group.id, name: "Still Active" });
      const inactive = await createTestEvent({
        groupId: group.id,
        name: "Gone",
      });
      await eventsTable.update(inactive.id, { active: false });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
    });

    test("hides both deactivate and reactivate for an empty group", async () => {
      const group = await createTestGroup({ name: "Empty Group" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
    });
  });
});
