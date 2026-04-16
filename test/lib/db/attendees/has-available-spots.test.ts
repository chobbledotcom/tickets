import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  hasAvailableSpots,
} from "#lib/db/attendees.ts";
import {
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
    const event = await createTestEvent({
      maxAttendees: 2,
      thankYouUrl: "https://example.com",
    });
    const result = await hasAvailableSpots(event.id);
    expect(result).toBe(true);
  });

  test("returns true when some spots taken", async () => {
    const event = await createTestEvent({
      maxAttendees: 2,
      thankYouUrl: "https://example.com",
    });
    await createTestAttendee(event.id, event.slug, "John", "john@example.com");

    const result = await hasAvailableSpots(event.id);
    expect(result).toBe(true);
  });

  test("returns false when event is full", async () => {
    const event = await createTestEvent({
      maxAttendees: 2,
      thankYouUrl: "https://example.com",
    });
    await createTestAttendee(event.id, event.slug, "John", "john@example.com");
    await createTestAttendee(event.id, event.slug, "Jane", "jane@example.com");

    const result = await hasAvailableSpots(event.id);
    expect(result).toBe(false);
  });

  test("checks per-date capacity for daily events", async () => {
    const event = await createTestEvent({
      bookableDays: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ],
      eventType: "daily",
      maxAttendees: 1,
      maximumDaysAfter: 14,
      minimumDaysBefore: 0,
    });

    await createAttendeeAtomic({
      bookings: [{ date: "2026-02-10", eventId: event.id }],
      email: "day@example.com",
      name: "Day User",
    });

    const full = await hasAvailableSpots(event.id, 1, "2026-02-10");
    expect(full).toBe(false);

    const available = await hasAvailableSpots(event.id, 1, "2026-02-11");
    expect(available).toBe(true);
  });

  test("multi-day range: every day must have room (event cap)", async () => {
    // Customer /api/availability must not report "available" for a range
    // whose middle or tail day is already full.
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 2,
      maximumDaysAfter: 30,
    });
    await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-03", durationDays: 1, eventId: event.id, quantity: 2 },
      ],
      email: "tail@example.com",
      name: "Tail",
    });
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 3)).toBe(false);
    // Single-day check on the same start date still reports available.
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 1)).toBe(true);
  });

  test("multi-day range: every day must have room (group cap)", async () => {
    // The event's own max is fine everywhere; the group cap is only
    // exceeded on day 2, so the multi-day request must still reject.
    const group = await createTestGroup({ maxAttendees: 2 });
    const event = await createDailyTestEvent({
      durationDays: 2,
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 30,
    });
    const sibling = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 30,
    });
    await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-02", durationDays: 1, eventId: sibling.id, quantity: 2 },
      ],
      email: "sib@example.com",
      name: "Sib",
    });
    expect(await hasAvailableSpots(event.id, 1, "2026-05-01", 2)).toBe(false);
  });
});
