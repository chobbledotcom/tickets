import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createTestAttendee,
  createTestEvent,
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

    await bookAttendee(event, {
      date: "2026-02-10",
      email: "day@example.com",
      name: "Day User",
    });

    const full = await hasAvailableSpots(event.id, 1, "2026-02-10");
    expect(full).toBe(false);

    const available = await hasAvailableSpots(event.id, 1, "2026-02-11");
    expect(available).toBe(true);
  });
});
