/**
 * End-to-end tests for multi-day bookings (duration_days).
 *
 * These exercise the full stack — creating events, booking, editing
 * durations, and verifying that availability, stored ranges, group caps,
 * email labels, ticket views, and admin pages all behave correctly as a
 * coherent system. Unit tests under test/lib/db/attendees/ cover each
 * function in isolation; these tests verify the pieces compose.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAvailableDates } from "#lib/dates.ts";
import {
  checkBatchAvailability,
  getAttendeesRaw,
  hasAvailableSpots,
} from "#lib/db/attendees.ts";
import { getEvent, getEventWithCount } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { buildTemplateData } from "#lib/email-renderer.ts";
import {
  adminFormPost,
  bookAttendee,
  createDailyTestEvent,
  createTestGroup,
  createTestHoliday,
  describeWithEnv,
  makeTestEntry,
  mockFormRequest,
  rawEventRange,
  setupEventAndLogin,
  updateTestEvent,
} from "#test-utils";

describeWithEnv("e2e: multi-day bookings", { db: true }, () => {
  describe("booking + stored range", () => {
    test("a 3-day booking stores a 3-day range and is visible from all layers", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });

      const result = await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      expect(result.success).toBe(true);

      const range = await rawEventRange(event.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-06-12T00:00:00Z");
      expect(range!.end_at).toBe("2026-06-15T00:00:00.000Z");
      expect(range!.quantity).toBe(2);
    });
  });

  describe("per-day capacity", () => {
    test("filling a middle day blocks a multi-day booking that spans it", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 2,
      });

      // Fill day 2 with a 1-day booking at capacity.
      await bookAttendee(event, { date: "2026-06-13", durationDays: 1, quantity: 2 });

      // 3-day booking starting day 1 covers 12–14 → day 13 is full.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-06-12",
        ),
      ).toBe(false);

      // hasAvailableSpots agrees.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 3)).toBe(
        false,
      );

      // But day 1 alone is still available.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 1)).toBe(true);
    });

    test("filling a tail day blocks the range but not the head", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 1,
      });
      await bookAttendee(event, { date: "2026-06-14", durationDays: 1 });

      // 3-day starting 2026-06-12 touches 12,13,14 — day 14 full.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 3)).toBe(
        false,
      );
      // Days 12 and 13 individually are fine.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 1)).toBe(true);
      expect(await hasAvailableSpots(event.id, 1, "2026-06-13", 1)).toBe(true);
    });
  });

  describe("group per-day capacity", () => {
    test("Saturday/Sunday/combo scenario respects group cap per day", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const sat = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
      });
      const combo = await createDailyTestEvent({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
      });

      // Fill Saturday: 5 via sat-only + 5 via combo (covers Sat+Sun).
      await bookAttendee(sat, { date: "2026-05-02", quantity: 5 });
      await bookAttendee(combo, { date: "2026-05-02", durationDays: 2, quantity: 5 });

      // Saturday group-full → 1 more on sat-only must reject.
      expect(
        await checkBatchAvailability(
          [{ eventId: sat.id, quantity: 1 }],
          "2026-05-02",
        ),
      ).toBe(false);

      // Sunday only has 5 (from combo), so 5 more on a new event should fit.
      const sun = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
      });
      expect(
        await checkBatchAvailability(
          [{ eventId: sun.id, quantity: 5 }],
          "2026-05-03",
        ),
      ).toBe(true);
      // But 6 on Sunday would breach group cap (5 combo + 6 = 11 > 10).
      expect(
        await checkBatchAvailability(
          [{ eventId: sun.id, quantity: 6 }],
          "2026-05-03",
        ),
      ).toBe(false);
    });
  });

  describe("admin duration edit + availability reconciliation", () => {
    test("changing duration updates existing booking ranges and shifts availability", async () => {
      const event = await createDailyTestEvent({
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });

      // Book day 10 as a 1-day booking.
      await bookAttendee(event, { date: "2026-08-10" });

      // Day 11 is available before the change.
      expect(await hasAvailableSpots(event.id, 1, "2026-08-11")).toBe(true);

      // Admin changes duration from 1 → 3.
      await updateTestEvent(event.id, { durationDays: 3 });

      // The booking now spans days 10, 11, 12 — verify stored end_at.
      const range = await rawEventRange(event.id);
      expect(range!.end_at).toBe("2026-08-13T00:00:00.000Z");

      // Day 11 is now occupied by the extended booking.
      expect(await hasAvailableSpots(event.id, 1, "2026-08-11")).toBe(false);
      // Day 12 is also occupied.
      expect(await hasAvailableSpots(event.id, 1, "2026-08-12")).toBe(false);
      // Day 13 is free (range is half-open: [10, 13)).
      expect(await hasAvailableSpots(event.id, 1, "2026-08-13")).toBe(true);

      // Verify the event metadata also changed.
      const fresh = await getEvent(event.id);
      expect(fresh?.duration_days).toBe(3);
    });

    test("shrinking duration frees previously-occupied days", async () => {
      const event = await createDailyTestEvent({
        durationDays: 5,
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });

      // Book a 5-day range starting day 10 → occupies 10–14.
      await bookAttendee(event, { date: "2026-08-10", durationDays: 5 });
      expect(await hasAvailableSpots(event.id, 1, "2026-08-14")).toBe(false);

      // Shrink duration to 2.
      await updateTestEvent(event.id, { durationDays: 2 });

      // Booking now spans 10–11. Days 12–14 are free.
      const range = await rawEventRange(event.id);
      expect(range!.end_at).toBe("2026-08-12T00:00:00.000Z");
      expect(await hasAvailableSpots(event.id, 1, "2026-08-12")).toBe(true);
      expect(await hasAvailableSpots(event.id, 1, "2026-08-14")).toBe(true);
    });

    test("changing duration back to 1 collapses ranges to single-day", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });
      await bookAttendee(event, { date: "2026-08-10", durationDays: 3 });

      await updateTestEvent(event.id, { durationDays: 1 });
      const range = await rawEventRange(event.id);
      expect(range!.end_at).toBe("2026-08-11T00:00:00.000Z");
      // Day 11 is now free.
      expect(await hasAvailableSpots(event.id, 1, "2026-08-11")).toBe(true);
    });
  });

  describe("available dates filtering", () => {
    test("multi-day range excludes start dates whose tail hits a holiday", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 10,
      });

      // Create a holiday 3 days from now.
      const today = new Date();
      today.setUTCDate(today.getUTCDate() + 3);
      const holidayDate = today.toISOString().slice(0, 10);
      await createTestHoliday({
        endDate: holidayDate,
        name: "Block",
        startDate: holidayDate,
      });
      const holidays = await getActiveHolidays();
      const dates = getAvailableDates(
        (await getEventWithCount(event.id))!,
        holidays,
      );

      // The holiday itself must not be a start date.
      expect(dates).not.toContain(holidayDate);
      // A start date 2 days before the holiday would have the holiday on
      // its 3rd day — must also be excluded.
      const twoBefore = new Date(today);
      twoBefore.setUTCDate(twoBefore.getUTCDate() - 2);
      const twoBeforeStr = twoBefore.toISOString().slice(0, 10);
      expect(dates).not.toContain(twoBeforeStr);
    });

    test("single-day events are unaffected by duration filtering", async () => {
      const event = await createDailyTestEvent({
        durationDays: 1,
        maxAttendees: 10,
      });
      const holidays = await getActiveHolidays();
      const dates = getAvailableDates(
        (await getEventWithCount(event.id))!,
        holidays,
      );
      // Should have at least some available dates (default 14-day window).
      expect(dates.length).toBeGreaterThan(0);
    });
  });

  describe("display: email + ticket view", () => {
    test("email template data shows date range for multi-day, single date for 1-day", () => {
      const multiDay = makeTestEntry(
        { duration_days: 3, event_type: "daily" },
        { date: "2026-06-12" },
      );
      const singleDay = makeTestEntry(
        { duration_days: 1, event_type: "daily" },
        { date: "2026-06-12" },
      );
      const noDate = makeTestEntry({}, { date: null });

      const data = buildTemplateData(
        [multiDay, singleDay, noDate],
        "GBP",
        "https://example.com/t/ABC",
      );
      // Multi-day: "12–14 June 2026" (inclusive last day, en dash).
      expect(data.entries[0]!.attendee.date_range_label).toBe(
        "12\u201314 June 2026",
      );
      // Single-day: full date with weekday.
      expect(data.entries[1]!.attendee.date_range_label).toContain("12 June");
      // No date: empty.
      expect(data.entries[2]!.attendee.date_range_label).toBe("");
    });
  });

  describe("edge cases", () => {
    test("back-to-back bookings at full capacity do not overlap", async () => {
      const event = await createDailyTestEvent({
        durationDays: 2,
        maxAttendees: 1,
      });

      // Book days 10–11.
      await bookAttendee(event, { date: "2026-08-10", durationDays: 2 });

      // Days 12–13 must be bookable (no overlap with 10–11).
      expect(await hasAvailableSpots(event.id, 1, "2026-08-12", 2)).toBe(true);
      // But days 11–12 overlap on day 11.
      expect(await hasAvailableSpots(event.id, 1, "2026-08-11", 2)).toBe(
        false,
      );
    });

    test("duration edit + new booking + duration edit again keeps ranges consistent", async () => {
      const event = await createDailyTestEvent({
        maxAttendees: 2,
        maximumDaysAfter: 60,
      });

      // Book attendee A on day 1 as 1-day.
      await bookAttendee(event, { date: "2026-09-01", email: "a@test.com" });

      // Expand to 3-day: A now covers days 1–3.
      await updateTestEvent(event.id, { durationDays: 3 });
      // Day 2 now has A (qty=1), cap=2 → room for 1 more but not 2.
      expect(await hasAvailableSpots(event.id, 2, "2026-09-02")).toBe(false);
      expect(await hasAvailableSpots(event.id, 1, "2026-09-02")).toBe(true);

      // Book attendee B on day 1 (room for 1 more since cap=2).
      await bookAttendee(event, {
        date: "2026-09-01",
        durationDays: 3,
        email: "b@test.com",
      });

      // Now at capacity on days 1–3. Day 4 should still be free.
      expect(await hasAvailableSpots(event.id, 1, "2026-09-04", 3)).toBe(true);
      expect(await hasAvailableSpots(event.id, 1, "2026-09-01", 3)).toBe(
        false,
      );

      // Shrink back to 1-day: both bookings collapse to day 1 only.
      await updateTestEvent(event.id, { durationDays: 1 });
      // Days 2 and 3 are now free.
      expect(await hasAvailableSpots(event.id, 1, "2026-09-02")).toBe(true);
      expect(await hasAvailableSpots(event.id, 1, "2026-09-03")).toBe(true);
      // Day 1 still full (2 bookings, cap 2).
      expect(await hasAvailableSpots(event.id, 1, "2026-09-01")).toBe(false);
    });

    test("multi-day booking across a group boundary respects both event and group caps", async () => {
      const group = await createTestGroup({ maxAttendees: 3 });
      const eventA = await createDailyTestEvent({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 10,
      });
      const eventB = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 10,
      });

      // Fill group on day 2 via eventB (3 attendees = group cap).
      await bookAttendee(eventB, { date: "2026-10-02", quantity: 3 });

      // eventA 2-day booking on day 1–2: day 1 is fine, day 2 is
      // group-full. Must reject even though eventA's own cap has room.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 2, eventId: eventA.id, quantity: 1 }],
          "2026-10-01",
        ),
      ).toBe(false);

      // A 1-day booking on day 1 alone should be fine.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 1, eventId: eventA.id, quantity: 1 }],
          "2026-10-01",
        ),
      ).toBe(true);
    });
  });

  describe("HTTP layer: admin add attendee", () => {
    test("admin-added attendee on a 3-day event stores a 3-day range", async () => {
      // This would have caught the bug where buildCreateAttendeeInput
      // omitted durationDays — the booking would silently store a 1-day
      // range regardless of the event's duration_days setting.
      const { handleRequest } = await import("#routes");
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: "2026-08-10",
            email: "admin-added@example.com",
            name: "Admin Added",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify the stored range spans 3 days, not 1.
      const range = await rawEventRange(event.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-08-10T00:00:00Z");
      expect(range!.end_at).toBe("2026-08-13T00:00:00.000Z");
    });

    test("admin-added attendee respects multi-day capacity", async () => {
      const { handleRequest } = await import("#routes");
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 1,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });

      // Fill day 11 with a 1-day booking.
      await bookAttendee(event, { date: "2026-08-11", durationDays: 1 });

      // Admin tries to add an attendee starting day 10 (3-day → 10,11,12).
      // Day 11 is full → must reject.
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: "2026-08-10",
            email: "blocked@example.com",
            name: "Blocked",
            quantity: "1",
          },
          cookie,
        ),
      );
      // Rejected — redirects with error flash, no new attendee.
      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });
  });

  describe("HTTP layer: admin event link management", () => {
    test("admin add-event-link stores multi-day range", async () => {
      // Admin attaches an attendee to a second multi-day event via the
      // link form. The new event_attendees row must use the event's
      // duration, not default to 1.
      const event1 = await createDailyTestEvent({ maxAttendees: 5 });
      const event2 = await createDailyTestEvent({
        durationDays: 4,
        maxAttendees: 5,
      });

      const result = await bookAttendee(event1, { date: "2026-07-01" });
      if (!result.success) throw new Error("setup");

      const { response } = await adminFormPost(
        `/admin/attendees/${result.attendees[0]!.id}/link`,
        {
          date: "2026-07-10",
          event_id: String(event2.id),
          quantity: "1",
        },
      );
      expect(response.status).toBe(302);

      const range = await rawEventRange(event2.id);
      expect(range).not.toBeNull();
      expect(range!.end_at).toBe("2026-07-14T00:00:00.000Z");
    });

    test("admin update-event-link preserves multi-day range on date move", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });
      const result = await bookAttendee(event, {
        date: "2026-07-01",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const { response } = await adminFormPost(
        `/admin/attendees/${result.attendees[0]!.id}/event/${event.id}`,
        {
          date: "2026-07-10",
          quantity: "1",
        },
      );
      expect(response.status).toBe(302);

      const range = await rawEventRange(event.id);
      expect(range!.start_at).toBe("2026-07-10T00:00:00Z");
      expect(range!.end_at).toBe("2026-07-13T00:00:00.000Z");
    });
  });

});
