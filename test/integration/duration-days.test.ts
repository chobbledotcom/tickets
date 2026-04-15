/**
 * Integration test for multi-day bookings (duration_days).
 *
 * Covers the key DURATION_PLAN phase 6 flow: create a daily event with
 * duration=3, book a start date, verify the stored range and confirm a
 * second overlapping booking is rejected when capacity fills up.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDateRangeLabelCompactEn } from "#lib/dates.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  recomputeEventBookingRanges,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { getEvent } from "#lib/db/events.ts";
import { buildTemplateData } from "#lib/email-renderer.ts";
import {
  createTestEvent,
  describeWithEnv,
  makeTestEntry,
  updateTestEvent,
} from "#test-utils";

describeWithEnv("integration: duration_days", { db: true }, () => {
  describe("multi-day booking flow", () => {
    test("books a start date and stores a 3-day range", async () => {
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
        name: "Weekend Retreat",
      });

      const result = await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-06-12",
            durationDays: 3,
            eventId: event.id,
            quantity: 2,
          },
        ],
        email: "range@example.com",
        name: "Range",
      });
      expect(result.success).toBe(true);

      const row = await getDb().execute({
        args: [event.id],
        sql: "SELECT start_at, end_at, quantity FROM event_attendees WHERE event_id = ?",
      });
      expect(row.rows.length).toBe(1);
      expect(String(row.rows[0]!.start_at)).toBe("2026-06-12T00:00:00Z");
      expect(String(row.rows[0]!.end_at)).toBe("2026-06-15T00:00:00.000Z");
      expect(Number(row.rows[0]!.quantity)).toBe(2);
    });

    test("second overlapping booking is rejected when a middle day is at capacity", async () => {
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
        name: "Crowded Retreat",
      });

      // Fill the middle day only with a separate 1-day booking
      await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-06-13",
            durationDays: 1,
            eventId: event.id,
            quantity: 2,
          },
        ],
        email: "middle@example.com",
        name: "Middle",
      });

      // A 3-day booking starting 2026-06-12 covers 12–14 → day 13 is full.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-06-12",
        ),
      ).toBe(false);
    });

    test("POST /admin/event/:id/edit reconciles booking ranges when duration changes", async () => {
      // Exercises the admin-edit HTTP path that wires a duration change into
      // recomputeEventBookingRanges. Previously this path was only tested at
      // the DB helper level.
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
        name: "Admin Edit Retreat",
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
      // 2026-08-10 + 5 days → 2026-08-15.
      expect(String(row.rows[0]!.end_at)).toBe("2026-08-15T00:00:00.000Z");

      const fresh = await getEvent(event.id);
      expect(fresh?.duration_days).toBe(5);
    });

    test("admin duration edit updates existing bookings' end_at", async () => {
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
        name: "Editable Retreat",
      });

      await createAttendeeAtomic({
        bookings: [{ date: "2026-06-12", eventId: event.id, quantity: 1 }],
        email: "original@example.com",
        name: "Original",
      });

      await recomputeEventBookingRanges(event.id, 4);

      const row = await getDb().execute({
        args: [event.id],
        sql: "SELECT end_at FROM event_attendees WHERE event_id = ?",
      });
      // start=2026-06-12 + 4 days → 2026-06-16 00:00:00.000Z (matches the
      // ISO format that fresh inserts produce via toISOString()).
      expect(String(row.rows[0]!.end_at)).toBe("2026-06-16T00:00:00.000Z");

      // Event metadata itself still needs updating separately; verify the
      // event can be read and has the original duration (reconciliation only
      // touches event_attendees).
      const fresh = await getEvent(event.id);
      expect(fresh?.duration_days).toBe(1);
    });

    test("email template surfaces a human-readable range for multi-day bookings", () => {
      const entries = [
        makeTestEntry(
          { duration_days: 3, event_type: "daily" },
          { date: "2026-06-12" },
        ),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );
      // 12–14 June 2026 (en dash within same month, same year)
      expect(data.entries[0]!.attendee.date_range_label).toBe(
        formatDateRangeLabelCompactEn("2026-06-12", "2026-06-14"),
      );
      expect(data.entries[0]!.attendee.date_range_label).toBe(
        "12\u201314 June 2026",
      );
    });
  });
});
