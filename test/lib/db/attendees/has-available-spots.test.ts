import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestEvent,
  createTestAttendee,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > hasAvailableSpots", { db: true }, () => {
  test("returns false for non-existent event", async () => {
    const result = await hasAvailableSpots(999);
    expect(result).toBe(false);
  });

  test("returns true when spots available", async () => {
    const event = await createTestEvent({ maxAttendees: 2 });
    expect(await hasAvailableSpots(event.id)).toBe(true);
  });

  test("returns true when some spots taken", async () => {
    const event = await createTestEvent({ maxAttendees: 2 });
    await createTestAttendee(event.id, event.slug, "John", "john@example.com");
    expect(await hasAvailableSpots(event.id)).toBe(true);
  });

  test("returns false when event is full", async () => {
    const event = await createTestEvent({ maxAttendees: 2 });
    await createTestAttendee(event.id, event.slug, "John", "john@example.com");
    await createTestAttendee(event.id, event.slug, "Jane", "jane@example.com");
    expect(await hasAvailableSpots(event.id)).toBe(false);
  });

  test("checks per-date capacity for daily events", async () => {
    const event = await createDailyTestEvent({ maxAttendees: 1 });
    await bookAttendee(event, { date: "2026-02-10" });
    expect(await hasAvailableSpots(event.id, 1, "2026-02-10")).toBe(false);
    expect(await hasAvailableSpots(event.id, 1, "2026-02-11")).toBe(true);
  });

  test("multi-day range: every day must have room (event cap)", async () => {
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 2,
    });
    await bookAttendee(event, {
      date: "2026-05-03",
      durationDays: 1,
      quantity: 2,
    });
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 3)).toBe(false);
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 1)).toBe(true);
  });

  test("multi-day range: every day must have room (group cap)", async () => {
    const group = await createTestGroup({ maxAttendees: 2 });
    const event = await createDailyTestEvent({
      durationDays: 2,
      groupId: group.id,
      maxAttendees: 100,
    });
    const sibling = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(sibling, { date: "2026-05-02", quantity: 2 });
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 2)).toBe(false);
  });

  test("multi-day range: an uncapped group never limits availability", async () => {
    const group = await createTestGroup({ maxAttendees: 0 });
    const event = await createDailyTestEvent({
      durationDays: 3,
      groupId: group.id,
      maxAttendees: 5,
    });
    const sibling = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(sibling, { date: "2026-05-02", quantity: 50 });
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 3)).toBe(true);
  });

  test("multi-day range: non-daily group rows count against every day", async () => {
    // Groups normally hold one event type, but an event can be flipped
    // after booking — its rows must then count on every day of the range
    // (the `event_type != 'daily'` arm of the group predicate).
    const group = await createTestGroup({ maxAttendees: 5 });
    const event = await createDailyTestEvent({
      durationDays: 2,
      groupId: group.id,
      maxAttendees: 100,
    });
    const sibling = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(sibling, { date: "2026-09-01", quantity: 3 });
    const { getDb } = await import("#shared/db/client.ts");
    await getDb().execute({
      args: [sibling.id],
      sql: "UPDATE events SET event_type = 'standard' WHERE id = ?",
    });
    // Sibling's 3 now count on every day — a 2-day booking far from
    // 2026-09-01 still only has 5 - 3 = 2 group spots per day.
    expect(await hasAvailableSpots(event.id, 3, "2026-11-01", 2)).toBe(false);
    expect(await hasAvailableSpots(event.id, 2, "2026-11-01", 2)).toBe(true);
  });
});
