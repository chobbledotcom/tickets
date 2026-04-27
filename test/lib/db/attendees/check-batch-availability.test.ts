import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkBatchAvailability } from "#shared/db/attendees.ts";
import { bookAttendee, createTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("db > attendees > checkBatchAvailability", { db: true }, () => {
  test("returns true for empty items", async () => {
    expect(await checkBatchAvailability([])).toBe(true);
  });

  test("returns false when event not found", async () => {
    expect(await checkBatchAvailability([{ eventId: 999, quantity: 1 }])).toBe(
      false,
    );
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
      maxAttendees: 2,
      maximumDaysAfter: 14,
      minimumDaysBefore: 0,
    });

    await bookAttendee(event, {
      date: "2026-05-01",
      email: "filled@example.com",
      name: "Filled",
      quantity: 2,
    });

    // Same date is full
    expect(
      await checkBatchAvailability(
        [{ eventId: event.id, quantity: 1 }],
        "2026-05-01",
      ),
    ).toBe(false);

    // Different date has room
    expect(
      await checkBatchAvailability(
        [{ eventId: event.id, quantity: 2 }],
        "2026-05-02",
      ),
    ).toBe(true);
  });
});
