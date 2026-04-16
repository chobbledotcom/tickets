import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#lib/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestEvent,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > updateEventLink", { db: true }, () => {
  test("updates quantity with capacity guard", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createTestEvent({ maxAttendees: 5 });
    const result = await bookAttendee(event, { quantity: 2 });
    if (!result.success) throw new Error("setup");
    const update = await updateEventLink(result.attendees[0]!.id, event.id, {
      date: null,
      quantity: 3,
    });
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(event.id))[0]!.quantity).toBe(3);
  });

  test("rejects update that would exceed capacity", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createTestEvent({ maxAttendees: 3 });
    const result = await bookAttendee(event, { quantity: 2 });
    if (!result.success) throw new Error("setup");
    const update = await updateEventLink(result.attendees[0]!.id, event.id, {
      date: null,
      quantity: 4,
    });
    expect(update.success).toBe(false);
  });

  test("updates date for daily event link", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createDailyTestEvent({ maxAttendees: 10 });
    const result = await bookAttendee(event, { date: "2026-04-07" });
    if (!result.success) throw new Error("setup");
    const update = await updateEventLink(result.attendees[0]!.id, event.id, {
      date: "2026-04-08",
      quantity: 1,
    });
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(event.id))[0]!.date).toBe("2026-04-08");
  });

  test("admits a multi-day update whose range contains non-overlapping bookings", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createDailyTestEvent({ durationDays: 3, maxAttendees: 2 });
    await bookAttendee(event, { date: "2026-06-01", durationDays: 1 });
    await bookAttendee(event, { date: "2026-06-03", durationDays: 1 });
    const target = await bookAttendee(event, { date: "2026-06-20", durationDays: 1 });
    if (!target.success) throw new Error("setup");
    const moved = await updateEventLink(target.attendees[0]!.id, event.id, {
      date: "2026-06-01",
      durationDays: 3,
      quantity: 1,
    });
    expect(moved.success).toBe(true);
  });

  test("returns capacity_exceeded for non-existent (attendee, event) pair", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createTestEvent({ maxAttendees: 5 });
    expect(
      (await updateEventLink(999_999, event.id, { date: null, quantity: 1 }))
        .success,
    ).toBe(false);
  });

  test("self-excludes on a group-capped daily event", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const group = await createTestGroup({ maxAttendees: 2 });
    const event = await createDailyTestEvent({ groupId: group.id, maxAttendees: 5 });
    const own = await bookAttendee(event, { date: "2026-07-01", quantity: 2 });
    if (!own.success) throw new Error("setup");
    const moved = await updateEventLink(own.attendees[0]!.id, event.id, {
      date: "2026-07-02",
      durationDays: 1,
      quantity: 2,
    });
    expect(moved.success).toBe(true);
  });

  test("self-excludes on a group-capped standard event", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const group = await createTestGroup({ maxAttendees: 3 });
    const event = await createTestEvent({
      eventType: "standard",
      groupId: group.id,
      maxAttendees: 10,
    });
    const own = await bookAttendee(event, { quantity: 2 });
    if (!own.success) throw new Error("setup");
    const resized = await updateEventLink(own.attendees[0]!.id, event.id, {
      date: null,
      quantity: 3,
    });
    expect(resized.success).toBe(true);
  });
});
