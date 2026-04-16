import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#lib/db/attendees.ts";
import {
  createDailyTestEvent,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

/** Seed a 1-day booking on `date` for `event` — tight helper for per-day
 * capacity fixtures below. */
const seed = (
  event: { id: number },
  date: string,
  quantity: number,
  email: string,
) =>
  createAttendeeAtomic({
    bookings: [{ date, durationDays: 1, eventId: event.id, quantity }],
    email,
    name: email,
  });

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

    test("rejects a multi-day booking when any day in the range is at capacity", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 2,
        maximumDaysAfter: 30,
      });
      // Fill day 2 only (middle of a 3-day range starting day 1).
      await seed(event, "2026-05-02", 2, "mid@example.com");
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);
    });

    test("accepts a multi-day booking when every day in the range has room", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 2,
        maximumDaysAfter: 30,
      });
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(true);
    });

    test("admits a 1-day booking in the gap between two full days", async () => {
      // Overlap-sum would see both existing single-day bookings inside a
      // multi-day overlap range and over-reject. Per-day expansion must
      // still admit a 1-day booking on the empty middle day.
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 2,
        maximumDaysAfter: 30,
      });
      await seed(event, "2026-05-01", 2, "d1@example.com");
      await seed(event, "2026-05-03", 2, "d3@example.com");
      expect(
        await checkBatchAvailability(
          [{ durationDays: 1, eventId: event.id, quantity: 2 }],
          "2026-05-02",
        ),
      ).toBe(true);
    });

    test("enforces group per-day cap across Saturday/Sunday/combo scenario", async () => {
      // Scenario from DURATION_PLAN: one group, cap 100. Three daily events
      // — a Saturday-only session, a Sunday-only session, and a combo that
      // spans both days. Per-day group occupancy must never exceed 100.
      const group = await createTestGroup({ maxAttendees: 100 });
      const sat = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 30,
      });
      const sun = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 30,
      });
      const combo = await createDailyTestEvent({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 30,
      });
      // Fill Saturday via sat-only + combo (50 + 50 = 100 at group level).
      await seed(sat, "2026-05-02", 50, "sat@example.com");
      await createAttendeeAtomic({
        bookings: [
          { date: "2026-05-02", durationDays: 2, eventId: combo.id, quantity: 50 },
        ],
        email: "combo@example.com",
        name: "Combo",
      });
      // Saturday full → adding 1 to the sat-only event must reject.
      expect(
        await checkBatchAvailability(
          [{ eventId: sat.id, quantity: 1 }],
          "2026-05-02",
        ),
      ).toBe(false);
      // Sunday has 50 (combo) + 0 = 50, so a 50-seat Sunday booking fits.
      expect(
        await checkBatchAvailability(
          [{ eventId: sun.id, quantity: 50 }],
          "2026-05-03",
        ),
      ).toBe(true);
    });

    test("rejects negative quantities upfront", async () => {
      // Public form clamps ≥1, but a negative quantity would otherwise
      // offset real demand and bypass the cap — defensive insurance.
      const event = await createTestEvent({ maxAttendees: 5 });
      expect(
        await checkBatchAvailability([{ eventId: event.id, quantity: -1 }]),
      ).toBe(false);
    });

    test("rejects a standard event booking exceeding total capacity", async () => {
      const event = await createTestEvent({
        eventType: "standard",
        maxAttendees: 2,
      });
      await createAttendeeAtomic({
        bookings: [{ eventId: event.id, quantity: 2 }],
        email: "full@example.com",
        name: "Full",
      });
      expect(
        await checkBatchAvailability([{ eventId: event.id, quantity: 1 }]),
      ).toBe(false);
    });
  },
);
