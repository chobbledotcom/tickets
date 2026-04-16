import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#lib/db/attendees.ts";
import { createDailyTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv(
  "db > attendees > checkBatchAvailability",
  { db: true },
  () => {
    test("returns true for empty items", async () => {
      expect(await checkBatchAvailability([])).toBe(true);
    });

    test("returns false when event not found", async () => {
      expect(
        await checkBatchAvailability([{ eventId: 999, quantity: 1 }]),
      ).toBe(false);
    });

    test("checks per-date capacity for daily events", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 2 });

      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 2 }],
        email: "filled@example.com",
        name: "Filled",
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
  },
);
