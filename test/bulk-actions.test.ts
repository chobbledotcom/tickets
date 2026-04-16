import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  eventsTable,
  getAllEvents,
  getEventWithCount,
} from "#lib/db/events.ts";
import { getAllGroups, getEventsByGroupId } from "#lib/db/groups.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

describeWithEnv("Admin bulk actions", { db: true }, () => {
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

  describe("GET /admin/groups/:id/bulk-actions/duplicate", () => {
    test("renders the duplicate form with event preview data", async () => {
      const group = await createTestGroup({ name: "Original" });
      await createTestEvent({ groupId: group.id, name: "Spring Workshop" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Duplicate Group");
      expect(html).toContain("Spring Workshop");
      expect(html).toContain('id="duplicate-preview-events"');
      // The default "new group name" suggestion is pre-filled.
      expect(html).toContain("Original (copy)");
    });

    test("shows an empty-state message when the group has no events", async () => {
      const group = await createTestGroup({ name: "Empty" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("This group has no events");
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/duplicate", () => {
    test("creates a new group and clones every event with replacements applied", async () => {
      const group = await createTestGroup({ name: "Source" });
      const sourceEvent = await createTestEvent({
        date: "2026-04-16T09:00",
        groupId: group.id,
        name: "Spring Workshop",
      });

      const groupCountBefore = (await getAllGroups()).length;
      const eventCountBefore = (await getAllEvents()).length;

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "2026-04-16",
          date_replace: "2026-04-23",
          name_find: "Spring",
          name_replace: "Autumn",
          new_name: "Duplicated Source",
        },
      );

      expect(response.status).toBe(302);

      const groupsAfter = await getAllGroups();
      expect(groupsAfter.length).toBe(groupCountBefore + 1);
      const newGroup = groupsAfter.find((g) => g.name === "Duplicated Source");
      expect(newGroup).toBeDefined();
      expect(newGroup!.slug).not.toBe(group.slug);

      // The redirect points at the new group's detail page
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${newGroup!.id}`,
      );

      const eventsAfter = await getAllEvents();
      expect(eventsAfter.length).toBe(eventCountBefore + 1);
      const newEvents = await getEventsByGroupId(newGroup!.id);
      expect(newEvents.length).toBe(1);
      const duplicate = newEvents[0]!;
      expect(duplicate.id).not.toBe(sourceEvent.id);
      expect(duplicate.name).toBe("Autumn Workshop");

      // The original date is shifted by 7 days; the time-of-day is preserved
      // (the exact hour in UTC depends on the configured timezone and DST).
      const originalMs = Date.parse(sourceEvent.date);
      const newMs = Date.parse(duplicate.date);
      expect(Math.round((newMs - originalMs) / 86_400_000)).toBe(7);

      // Source event should still exist and be unchanged.
      const original = await getEventWithCount(sourceEvent.id);
      expect(original?.name).toBe("Spring Workshop");
      expect(original?.date).toBe(sourceEvent.date);
      expect(original?.group_id).toBe(group.id);
    });

    test("duplicates with no replacements copies names and dates verbatim", async () => {
      const group = await createTestGroup({ name: "Verbatim" });
      const sourceEvent = await createTestEvent({
        date: "2026-05-01T10:00",
        groupId: group.id,
        name: "Untouched",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          name_find: "",
          name_replace: "",
          new_name: "Verbatim Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await getAllGroups()).find(
        (g) => g.name === "Verbatim Copy",
      );
      expect(newGroup).toBeDefined();
      const newEvents = await getEventsByGroupId(newGroup!.id);
      expect(newEvents[0]!.name).toBe("Untouched");
      expect(newEvents[0]!.date).toBe(sourceEvent.date);
    });

    test("rejects an empty new group name with an error flash", async () => {
      const group = await createTestGroup({ name: "Needs Name" });
      await createTestEvent({ groupId: group.id, name: "E" });

      const groupCountBefore = (await getAllGroups()).length;

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          name_find: "",
          name_replace: "",
          new_name: "",
        },
      );

      expect(response.status).toBe(302);
      // Redirect back to the form, not on to a new group page
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      expect((await getAllGroups()).length).toBe(groupCountBefore);
    });

    test("returns 404 when the source group does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/groups/999999/bulk-actions/duplicate",
        { new_name: "Orphan" },
      );
      expect(response.status).toBe(404);
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
