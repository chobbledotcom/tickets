/**
 * Integration test for multi-day bookings (duration_days).
 *
 * Unit tests under test/lib/db/attendees/ already cover each layer —
 * this file exercises the one end-to-end path not reachable there: an
 * admin POST /admin/event/:id/edit that changes duration and triggers
 * booking-range reconciliation.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { getEvent } from "#lib/db/events.ts";
import {
  createDailyTestEvent,
  describeWithEnv,
  updateTestEvent,
} from "#test-utils";

describeWithEnv("integration: duration_days", { db: true }, () => {
  describe("admin edit flow", () => {
    test("POST /admin/event/:id/edit reconciles booking ranges when duration changes", async () => {
      const event = await createDailyTestEvent({
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await createAttendeeAtomic({
        bookings: [{ date: "2026-08-10", eventId: event.id, quantity: 1 }],
        email: "edit@example.com",
        name: "Edit",
      });

      await updateTestEvent(event.id, { durationDays: 5 });

      const row = await getDb().execute({
        args: [event.id],
        sql: "SELECT end_at FROM event_attendees WHERE event_id = ?",
      });
      expect(String(row.rows[0]!.end_at)).toBe("2026-08-15T00:00:00.000Z");

      const fresh = await getEvent(event.id);
      expect(fresh?.duration_days).toBe(5);
    });
  });
});
