import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getActiveEventsByGroupId } from "#lib/db/groups.ts";
import {
  buildTicketEventsForGroup,
  buildTicketEventsWithGroupCapacity,
} from "#routes/public/ticket-events.ts";
import {
  bookAttendee,
  createTestEvent,
  createTestGroup,
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
  });

  describe("buildTicketEventsForGroup", () => {
    test("clamps spots using group's max minus summed attendee counts", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "for-group",
        slug: "for-group",
      });
      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "for-group-a",
      });
      const e2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "for-group-b",
      });
      await bookAttendee(e1, { email: "y@test.com", name: "Y" });
      await bookAttendee(e1, { email: "z@test.com", name: "Z" });

      const events = await getActiveEventsByGroupId(group.id);
      const ticketEvents = buildTicketEventsForGroup(group, events);
      const ea = ticketEvents.find((t) => t.event.id === e1.id)!;
      const eb = ticketEvents.find((t) => t.event.id === e2.id)!;
      expect(ea.maxPurchasable).toBe(3);
      expect(eb.maxPurchasable).toBe(3);
    });

    test("skips group cap when group is daily", async () => {
      const group = await createTestGroup({
        maxAttendees: 1,
        name: "for-group-daily",
        slug: "for-group-daily",
      });
      await createTestEvent({
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 4,
        name: "for-group-daily-a",
      });
      const events = await getActiveEventsByGroupId(group.id);
      const [ticketEvent] = buildTicketEventsForGroup(group, events);
      expect(ticketEvent!.maxPurchasable).toBe(4);
    });

    test("skips group cap when group has no max set", async () => {
      const group = await createTestGroup({
        name: "for-group-uncapped",
        slug: "for-group-uncapped",
      });
      await createTestEvent({
        groupId: group.id,
        maxAttendees: 8,
        maxQuantity: 8,
        name: "for-group-uncapped-a",
      });
      const events = await getActiveEventsByGroupId(group.id);
      const [ticketEvent] = buildTicketEventsForGroup(group, events);
      expect(ticketEvent!.maxPurchasable).toBe(8);
    });

    test("clamps remaining at zero when overbooked", async () => {
      const group = await createTestGroup({
        maxAttendees: 1,
        name: "for-group-overbooked",
        slug: "for-group-overbooked",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "for-group-overbooked-a",
      });
      await bookAttendee(event, { email: "aa@test.com", name: "AA" });

      const events = await getActiveEventsByGroupId(group.id);
      const [ticketEvent] = buildTicketEventsForGroup(group, events);
      expect(ticketEvent!.isSoldOut).toBe(true);
      expect(ticketEvent!.maxPurchasable).toBe(0);
    });
  });
});
