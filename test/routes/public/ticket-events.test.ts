import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketEventsWithGroupCapacity } from "#routes/public/ticket-events.ts";
import { getActiveEventsByGroupId } from "#shared/db/groups.ts";
import {
  bookAttendee,
  createTestEvent,
  createTestGroup,
  deactivateTestEvent,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("routes > public > ticket-events", { db: true }, () => {
  describe("buildTicketEventsWithGroupCapacity", () => {
    test("clamps spots to group remaining for standard events", async () => {
      const group = await createTestGroup({
        maxAttendees: 4,
        name: "with-cap",
        slug: "with-cap-1",
      });
      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "with-cap-a",
      });
      const e2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "with-cap-b",
      });
      await bookAttendee(e1, { email: "x@test.com", name: "X" });

      const events = await getActiveEventsByGroupId(group.id);
      const ticketEvents = await buildTicketEventsWithGroupCapacity(events);
      const eb = ticketEvents.find((t) => t.event.id === e2.id)!;
      expect(eb.maxPurchasable).toBe(3);
      expect(eb.isSoldOut).toBe(false);
    });

    test("does not clamp when group is daily", async () => {
      const group = await createTestGroup({
        maxAttendees: 1,
        name: "daily-no-clamp",
        slug: "daily-no-clamp",
      });
      const e1 = await createTestEvent({
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 5,
        name: "daily-a",
      });

      const events = await getActiveEventsByGroupId(group.id);
      const [ticketEvent] = await buildTicketEventsWithGroupCapacity(events);
      expect(ticketEvent!.maxPurchasable).toBe(5);
      expect(ticketEvent!.isSoldOut).toBe(false);
      expect(ticketEvent!.event.id).toBe(e1.id);
    });

    test("counts attendees on inactive sibling events toward group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 4,
        name: "inactive-sibling",
        slug: "inactive-sibling",
      });
      const inactive = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "inactive-event",
      });
      const active = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "active-event",
      });
      await bookAttendee(inactive, { email: "p@test.com", name: "P" });
      await bookAttendee(inactive, { email: "q@test.com", name: "Q" });
      await deactivateTestEvent(inactive.id);

      const events = await getActiveEventsByGroupId(group.id);
      expect(events.map((e) => e.id)).toEqual([active.id]);
      const [ticketEvent] = await buildTicketEventsWithGroupCapacity(events);
      expect(ticketEvent!.maxPurchasable).toBe(2);
    });
  });
});
