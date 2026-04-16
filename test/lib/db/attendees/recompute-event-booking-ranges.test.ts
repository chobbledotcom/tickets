import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  recomputeEventBookingRanges,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import {
  createDailyTestEvent,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";

const getRow = async (eventId: number) => {
  const res = await getDb().execute({
    args: [eventId],
    sql: "SELECT start_at, end_at FROM event_attendees WHERE event_id = ?",
  });
  return res.rows[0]!;
};

describeWithEnv(
  "db > attendees > recomputeEventBookingRanges",
  { db: true },
  () => {
    test("updates existing end_at to start_at + N days with ISO .000Z suffix", async () => {
      // Stored format must match fresh toISOString() output — locks lexical
      // comparisons to a single shape and keeps raw-row dumps tidy.
      const event = await createDailyTestEvent({
        maxAttendees: 5,
        maximumDaysAfter: 30,
      });
      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 1 }],
        email: "fmt@example.com",
        name: "Fmt",
      });
      await recomputeEventBookingRanges(event.id, 3);
      const row = await getRow(event.id);
      expect(String(row.end_at)).toBe("2026-05-04T00:00:00.000Z");
    });

    test("clamps durationDays < 1 to 1", async () => {
      const event = await createDailyTestEvent({
        durationDays: 2,
        maxAttendees: 5,
        maximumDaysAfter: 30,
      });
      await createAttendeeAtomic({
        bookings: [
          { date: "2026-05-01", durationDays: 2, eventId: event.id, quantity: 1 },
        ],
        email: "c@example.com",
        name: "Clamp",
      });
      await recomputeEventBookingRanges(event.id, 0);
      const row = await getRow(event.id);
      const diffDays =
        (new Date(String(row.end_at)).getTime() -
          new Date(String(row.start_at)).getTime()) /
        86_400_000;
      expect(diffDays).toBe(1);
    });

    test("leaves non-daily (NULL start_at) rows alone", async () => {
      const daily = await createDailyTestEvent({
        maxAttendees: 5,
        maximumDaysAfter: 30,
      });
      const standard = await createTestEvent({
        eventType: "standard",
        maxAttendees: 5,
      });
      await createAttendeeAtomic({
        bookings: [
          { eventId: standard.id, quantity: 1 },
          { date: "2026-05-01", eventId: daily.id, quantity: 1 },
        ],
        email: "mix@example.com",
        name: "Mixed",
      });
      await recomputeEventBookingRanges(standard.id, 7);
      const row = await getRow(standard.id);
      expect(row.start_at).toBeNull();
      expect(row.end_at).toBeNull();
    });
  },
);
