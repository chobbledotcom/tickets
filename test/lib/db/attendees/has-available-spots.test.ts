import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasAvailableSpots } from "#lib/db/attendees.ts";
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
    const event = await createDailyTestEvent({ durationDays: 3, maxAttendees: 2 });
    await bookAttendee(event, { date: "2026-05-03", durationDays: 1, quantity: 2 });
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
    const sibling = await createDailyTestEvent({ groupId: group.id, maxAttendees: 100 });
    await bookAttendee(sibling, { date: "2026-05-02", quantity: 2 });
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 2)).toBe(false);
  });
});
