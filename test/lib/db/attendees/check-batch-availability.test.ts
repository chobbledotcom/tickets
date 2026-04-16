import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkBatchAvailability } from "#lib/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestEvent,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

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
      await bookAttendee(event, { date: "2026-05-01", quantity: 2 });
      expect(
        await checkBatchAvailability(
          [{ eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);
      expect(
        await checkBatchAvailability(
          [{ eventId: event.id, quantity: 2 }],
          "2026-05-02",
        ),
      ).toBe(true);
    });

    test("rejects a multi-day booking when any day in the range is at capacity", async () => {
      const event = await createDailyTestEvent({ durationDays: 3, maxAttendees: 2 });
      await bookAttendee(event, { date: "2026-05-02", durationDays: 1, quantity: 2 });
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);
    });

    test("accepts a multi-day booking when every day has room", async () => {
      const event = await createDailyTestEvent({ durationDays: 3, maxAttendees: 2 });
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(true);
    });

    test("admits a 1-day booking in the gap between two full days", async () => {
      const event = await createDailyTestEvent({ durationDays: 3, maxAttendees: 2 });
      await bookAttendee(event, { date: "2026-05-01", durationDays: 1, quantity: 2 });
      await bookAttendee(event, { date: "2026-05-03", durationDays: 1, quantity: 2 });
      expect(
        await checkBatchAvailability(
          [{ durationDays: 1, eventId: event.id, quantity: 2 }],
          "2026-05-02",
        ),
      ).toBe(true);
    });

    test("enforces group per-day cap across Saturday/Sunday/combo scenario", async () => {
      const group = await createTestGroup({ maxAttendees: 100 });
      const sat = await createDailyTestEvent({ groupId: group.id, maxAttendees: 100 });
      const sun = await createDailyTestEvent({ groupId: group.id, maxAttendees: 100 });
      const combo = await createDailyTestEvent({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
      });
      await bookAttendee(sat, { date: "2026-05-02", quantity: 50 });
      await bookAttendee(combo, { date: "2026-05-02", durationDays: 2, quantity: 50 });
      expect(
        await checkBatchAvailability([{ eventId: sat.id, quantity: 1 }], "2026-05-02"),
      ).toBe(false);
      expect(
        await checkBatchAvailability([{ eventId: sun.id, quantity: 50 }], "2026-05-03"),
      ).toBe(true);
    });

    test("rejects negative quantities", async () => {
      const event = await createTestEvent({ maxAttendees: 5 });
      expect(
        await checkBatchAvailability([{ eventId: event.id, quantity: -1 }]),
      ).toBe(false);
    });

    test("rejects a standard event exceeding total capacity", async () => {
      const event = await createTestEvent({ eventType: "standard", maxAttendees: 2 });
      await bookAttendee(event, { quantity: 2 });
      expect(
        await checkBatchAvailability([{ eventId: event.id, quantity: 1 }]),
      ).toBe(false);
    });
  },
);
