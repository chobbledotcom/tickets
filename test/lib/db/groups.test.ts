import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  hasAvailableSpots,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { getEvent } from "#lib/db/events.ts";
import {
  computeGroupSlugIndex,
  getActiveEventsByGroupId,
  getAllGroups,
  getGroupBySlugIndex,
  groupsTable,
  isGroupSlugTaken,
  resetGroupEvents,
} from "#lib/db/groups.ts";
import {
  bookAttendee,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > groups", { db: true }, () => {
  describe("CRUD", () => {
    test("groupsTable create, update, findById, deleteById", async () => {
      const created = await createTestGroup({
        name: "DB Group",
        slug: "db-group",
      });

      const fetched = await groupsTable.findById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("DB Group");
      expect(fetched?.slug).toBe("db-group");

      const updated = await groupsTable.update(created.id, {
        name: "DB Group Updated",
        termsAndConditions: "Terms",
      });
      expect(updated?.name).toBe("DB Group Updated");
      expect(updated?.terms_and_conditions).toBe("Terms");

      await groupsTable.deleteById(created.id);
      expect(await groupsTable.findById(created.id)).toBeNull();
    });

    test("getAllGroups returns decrypted groups ordered by id", async () => {
      const g1 = await createTestGroup({ name: "Group A", slug: "group-a" });
      const g2 = await createTestGroup({ name: "Group B", slug: "group-b" });
      const groups = await getAllGroups();
      expect(groups.length).toBe(2);
      expect(groups[0]?.id).toBe(g1.id);
      expect(groups[1]?.id).toBe(g2.id);
      expect(groups[0]?.name).toBe("Group A");
      expect(groups[1]?.name).toBe("Group B");
    });

    test("getGroupBySlugIndex returns group or null", async () => {
      const group = await createTestGroup({
        name: "Index Group",
        slug: "idx-group",
      });

      const found = await getGroupBySlugIndex(
        await computeGroupSlugIndex("idx-group"),
      );
      expect(found?.slug).toBe(group.slug);
      expect(await getGroupBySlugIndex("missing")).toBeNull();
    });

    test("isGroupSlugTaken checks both groups and events", async () => {
      const groupSlug = "taken-by-group";
      const created = await createTestGroup({
        name: "Taken",
        slug: groupSlug,
      });

      expect(await isGroupSlugTaken(groupSlug)).toBe(true);
      expect(await isGroupSlugTaken(groupSlug, created.id)).toBe(false);

      const event = await createTestEvent({ name: "Taken Event" });
      expect(await isGroupSlugTaken(event.slug)).toBe(true);
    });

    test("getActiveEventsByGroupId returns active events with attendee counts", async () => {
      const group = await createTestGroup({
        name: "Events Group",
        slug: "events-group",
      });

      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Active In Group",
      });
      const e2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Inactive In Group",
      });
      await getDb().execute({
        args: [e2.id],
        sql: "UPDATE events SET active = 0 WHERE id = ?",
      });

      const attendee = await bookAttendee(e1, {
        email: "a@example.com",
        name: "A",
        quantity: 3,
      });
      if (!attendee.success) throw new Error("Failed to create attendee");

      const events = await getActiveEventsByGroupId(group.id);
      expect(events.length).toBe(1);
      expect(events[0]?.id).toBe(e1.id);
      expect(events[0]?.attendee_count).toBe(3);
    });

    test("resetGroupEvents sets group_id to 0", async () => {
      const group = await createTestGroup({
        name: "Reset Group",
        slug: "reset-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Reset Event",
      });
      await resetGroupEvents(group.id);
      expect((await getEvent(event.id))?.group_id).toBe(0);
    });
  });

  describe("capacity", () => {
    /** Create a capped group with two events (each with event-level max of 10) */
    const createCappedGroupWithEvents = async (
      groupMax: number,
      slug: string,
      overrides?: { eventType?: "standard" | "daily" },
    ) => {
      const group = await createTestGroup({
        maxAttendees: groupMax,
        name: slug,
        slug,
      });
      const e1 = await createTestEvent({
        eventType: overrides?.eventType,
        groupId: group.id,
        maxAttendees: 10,
        name: `${slug}-a`,
      });
      const e2 = await createTestEvent({
        eventType: overrides?.eventType,
        groupId: group.id,
        maxAttendees: 10,
        name: `${slug}-b`,
      });
      return { e1, e2, group };
    };

    /** Book attendees atomically with minimal boilerplate */
    const book = (eventId: number, quantity: number, date?: string) =>
      createAttendeeAtomic({
        bookings: [{ date, eventId, quantity }],
        email: `a${eventId}q${quantity}@example.com`,
        name: `attendee-${eventId}-${quantity}`,
      });

    test("createAttendeeAtomic enforces group max_attendees across events", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(5, "capped");

      expect((await book(e1.id, 3)).success).toBe(true);

      const r2 = await book(e2.id, 3);
      expect(r2.success).toBe(false);
      if (!r2.success) expect(r2.reason).toBe("capacity_exceeded");

      expect((await book(e2.id, 2)).success).toBe(true);
    });

    test("createAttendeeAtomic allows booking when group has no max (0)", async () => {
      const group = await createTestGroup({
        name: "unlimited",
        slug: "unlimited",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        name: "unlimited-event",
      });

      expect((await book(event.id, 50)).success).toBe(true);
    });

    test("hasAvailableSpots checks group capacity", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(3, "spots");

      await book(e1.id, 2);

      expect(await hasAvailableSpots(e2.id, 1)).toBe(true);
      expect(await hasAvailableSpots(e2.id, 2)).toBe(false);
    });

    test("checkBatchAvailability checks group capacity", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(4, "batch");

      expect(
        await checkBatchAvailability([
          { eventId: e1.id, quantity: 3 },
          { eventId: e2.id, quantity: 2 },
        ]),
      ).toBe(false);

      expect(
        await checkBatchAvailability([
          { eventId: e1.id, quantity: 2 },
          { eventId: e2.id, quantity: 2 },
        ]),
      ).toBe(true);
    });

    test("checkBatchAvailability skips group check when group has no limit", async () => {
      const group = await createTestGroup({
        name: "no-limit",
        slug: "no-limit",
      });
      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        name: "no-limit-a",
      });
      const ungrouped = await createTestEvent({
        maxAttendees: 100,
        name: "ungrouped",
      });

      expect(
        await checkBatchAvailability([
          { eventId: e1.id, quantity: 50 },
          { eventId: ungrouped.id, quantity: 50 },
        ]),
      ).toBe(true);
    });

    test("checkBatchAvailability handles events from multiple groups", async () => {
      const { e1: eA } = await createCappedGroupWithEvents(3, "multi-a");
      const { e1: eB } = await createCappedGroupWithEvents(3, "multi-b");

      expect(
        await checkBatchAvailability([
          { eventId: eA.id, quantity: 2 },
          { eventId: eB.id, quantity: 2 },
        ]),
      ).toBe(true);
    });

    test("capacity check handles deleted group gracefully", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "delete-me",
        slug: "delete-me",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "orphan-event",
      });
      await groupsTable.deleteById(group.id);

      expect(await hasAvailableSpots(event.id, 1)).toBe(true);
    });

    test("max_attendees is per-date for daily events", async () => {
      const { e1: event } = await createCappedGroupWithEvents(3, "daily", {
        eventType: "daily",
      });

      expect((await book(event.id, 3, "2026-07-01")).success).toBe(true);
      expect((await book(event.id, 1, "2026-07-01")).success).toBe(false);
      expect((await book(event.id, 3, "2026-07-02")).success).toBe(true);
    });

    test("daily group cap counts across multiple events for same date", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(4, "daily-multi", {
        eventType: "daily",
      });

      expect((await book(e1.id, 2, "2026-07-01")).success).toBe(true);
      expect((await book(e2.id, 2, "2026-07-01")).success).toBe(true);
      expect((await book(e2.id, 1, "2026-07-01")).success).toBe(false);
      expect((await book(e2.id, 3, "2026-07-02")).success).toBe(true);
    });

    test("hasAvailableSpots checks group capacity for daily events with date", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(3, "daily-spots", {
        eventType: "daily",
      });

      await book(e1.id, 2, "2026-08-01");

      expect(await hasAvailableSpots(e2.id, 1, "2026-08-01")).toBe(true);
      expect(await hasAvailableSpots(e2.id, 2, "2026-08-01")).toBe(false);
      expect(await hasAvailableSpots(e2.id, 3, "2026-08-02")).toBe(true);
    });

    test("checkBatchAvailability checks group capacity with date for daily events", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(5, "daily-batch", {
        eventType: "daily",
      });

      expect(
        await checkBatchAvailability(
          [
            { eventId: e1.id, quantity: 3 },
            { eventId: e2.id, quantity: 3 },
          ],
          "2026-09-01",
        ),
      ).toBe(false);

      expect(
        await checkBatchAvailability(
          [
            { eventId: e1.id, quantity: 2 },
            { eventId: e2.id, quantity: 3 },
          ],
          "2026-09-01",
        ),
      ).toBe(true);
    });

    test("checkBatchAvailability considers pre-existing attendees in group", async () => {
      const { e1, e2 } = await createCappedGroupWithEvents(5, "pre-exist");

      await book(e1.id, 3);

      expect(
        await checkBatchAvailability([{ eventId: e2.id, quantity: 3 }]),
      ).toBe(false);

      expect(
        await checkBatchAvailability([{ eventId: e2.id, quantity: 2 }]),
      ).toBe(true);
    });

    test("event-level cap rejects even when group has room", async () => {
      const group = await createTestGroup({
        maxAttendees: 100,
        name: "big-group",
        slug: "big-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 2,
        name: "small-event",
      });

      expect((await book(event.id, 2)).success).toBe(true);
      const r = await book(event.id, 1);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.reason).toBe("capacity_exceeded");
    });

    test("hasAvailableSpots respects event cap even when group has room", async () => {
      const group = await createTestGroup({
        maxAttendees: 100,
        name: "big-group2",
        slug: "big-group2",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 1,
        name: "tiny-event",
      });

      await book(event.id, 1);
      expect(await hasAvailableSpots(event.id, 1)).toBe(false);
    });

    test("checkBatchAvailability rejects when one group is full and another has room", async () => {
      const { e1: fullGroupEvent } = await createCappedGroupWithEvents(
        2,
        "full-grp",
      );
      const { e1: openGroupEvent } = await createCappedGroupWithEvents(
        10,
        "open-grp",
      );

      await book(fullGroupEvent.id, 2);

      expect(
        await checkBatchAvailability([
          { eventId: fullGroupEvent.id, quantity: 1 },
          { eventId: openGroupEvent.id, quantity: 1 },
        ]),
      ).toBe(false);

      expect(
        await checkBatchAvailability([
          { eventId: openGroupEvent.id, quantity: 1 },
        ]),
      ).toBe(true);
    });
  });
});
