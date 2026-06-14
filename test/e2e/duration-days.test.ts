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
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { getEventActivityLog } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { addDays, getAvailableDates } from "#shared/dates.ts";
import {
  checkBatchAvailability,
  checkGroupCapAfterDurationChange,
  createAttendeeAtomic,
  getAttendeesRaw,
  hasAvailableSpots,
  unlinkAttendeeFromEvent,
} from "#shared/db/attendees.ts";
import { getEvent, getEventWithCount } from "#shared/db/events.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { buildTemplateData } from "#shared/email-renderer.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { generateAttendeesCsv } from "#templates/csv.ts";
import {
  adminFormPost,
  apiRequest,
  assertJson,
  awaitTestRequest,
  bookAttendee,
  createDailyTestEvent,
  createTestGroup,
  createTestHoliday,
  describeWithEnv,
  expectRedirectWithFlash,
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
      await bookAttendee(event, {
        date: "2026-06-13",
        durationDays: 1,
        quantity: 2,
      });

      // 3-day booking starting day 1 covers 12–14 → day 13 is full.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 3)).toBe(false);
    });

    test("single day within a blocked multi-day range is still bookable alone", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 2,
      });
      await bookAttendee(event, {
        date: "2026-06-13",
        durationDays: 1,
        quantity: 2,
      });

      // Day 1 alone (before the full day) is still available.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 1)).toBe(true);
    });

    test("filling a tail day blocks the range but not the head", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 1,
      });
      await bookAttendee(event, { date: "2026-06-14", durationDays: 1 });

      // 3-day starting 2026-06-12 touches 12,13,14 — day 14 full.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 3)).toBe(false);
      // Days 12 and 13 individually are fine.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-12", 1)).toBe(true);
      expect(await hasAvailableSpots(event.id, 1, "2026-06-13", 1)).toBe(true);
    });
  });

  describe("group per-day capacity", () => {
    test("combo booking fills Saturday group cap across events", async () => {
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
      await bookAttendee(combo, {
        date: "2026-05-02",
        durationDays: 2,
        quantity: 5,
      });

      // Saturday group-full → 1 more on sat-only must reject.
      expect(
        await checkBatchAvailability(
          [{ eventId: sat.id, quantity: 1 }],
          "2026-05-02",
        ),
      ).toBe(false);
    });

    test("Sunday still has room when only the combo spans both days", async () => {
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
      const sun = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
      });

      await bookAttendee(sat, { date: "2026-05-02", quantity: 5 });
      await bookAttendee(combo, {
        date: "2026-05-02",
        durationDays: 2,
        quantity: 5,
      });

      // Sunday has 5 from combo only → 5 more fits.
      expect(
        await checkBatchAvailability(
          [{ eventId: sun.id, quantity: 5 }],
          "2026-05-03",
        ),
      ).toBe(true);
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

    test("single-day event offers more start dates than multi-day for same window", async () => {
      const single = await createDailyTestEvent({
        durationDays: 1,
        maxAttendees: 10,
      });
      const multi = await createDailyTestEvent({
        durationDays: 5,
        maxAttendees: 10,
      });
      const holidays = await getActiveHolidays();
      const singleDates = getAvailableDates(
        (await getEventWithCount(single.id))!,
        holidays,
      );
      const multiDates = getAvailableDates(
        (await getEventWithCount(multi.id))!,
        holidays,
      );
      // Multi-day has fewer start dates because the tail must fit in the window.
      expect(singleDates.length).toBeGreaterThan(multiDates.length);
    });
  });

  describe("display: email template date_range_label", () => {
    const labelFor = (
      event: Parameters<typeof makeTestEntry>[0],
      attendee: Parameters<typeof makeTestEntry>[1],
    ) =>
      buildTemplateData(
        [makeTestEntry(event, attendee)],
        "GBP",
        "https://example.com/t/ABC",
      ).entries[0]!.attendee.date_range_label;

    test("multi-day booking shows en-dash range", () => {
      expect(
        labelFor(
          { duration_days: 3, event_type: "daily" },
          { date: "2026-06-12" },
        ),
      ).toBe("12\u201314 June 2026");
    });

    test("single-day booking shows full date", () => {
      expect(
        labelFor(
          { duration_days: 1, event_type: "daily" },
          { date: "2026-06-12" },
        ),
      ).toContain("12 June");
    });

    test("no-date booking shows empty string", () => {
      expect(labelFor({}, { date: null })).toBe("");
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
      expect(await hasAvailableSpots(event.id, 1, "2026-08-11", 2)).toBe(false);
    });

    test("expand-book-shrink cycle keeps all ranges consistent", async () => {
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
      expect(await hasAvailableSpots(event.id, 1, "2026-09-01", 3)).toBe(false);

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

  describe("CSV export", () => {
    test("date column shows range for multi-day bookings", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });
      await bookAttendee(event, { date: "2026-06-12", durationDays: 3 });
      const attendees = await getAttendeesRaw(event.id);
      const csv = generateAttendeesCsv(
        attendees,
        true,
        undefined,
        undefined,
        3,
      );
      expect(csv).toContain("2026-06-12 to 2026-06-14");
    });

    test("date column shows single date for 1-day bookings", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 5 });
      await bookAttendee(event, { date: "2026-06-12" });
      const attendees = await getAttendeesRaw(event.id);
      const csv = generateAttendeesCsv(attendees, true);
      expect(csv).toContain("2026-06-12");
      expect(csv).not.toContain("to");
    });
  });

  describe("group cap + duration change interaction", () => {
    test("no-limit group returns null (no cap to violate)", async () => {
      const group = await createTestGroup({ maxAttendees: 0 });
      const event = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
      });
      await bookAttendee(event, { date: "2026-10-01", quantity: 50 });
      expect(
        await checkGroupCapAfterDurationChange(event.id, group.id),
      ).toBeNull();
    });

    test("checkGroupCapAfterDurationChange counts rows of a type-flipped event on every day", async () => {
      // A sibling event flipped to standard after booking: its rows count
      // toward the group cap on every day, so day 1 of the daily event's
      // booking (5 + 6 = 11 > 10) overflows even with no range overlap.
      const group = await createTestGroup({ maxAttendees: 10 });
      const daily = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const sibling = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(daily, { date: "2026-10-01", quantity: 5 });
      await bookAttendee(sibling, { date: "2026-10-20", quantity: 6 });
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute({
        args: [sibling.id],
        sql: "UPDATE events SET event_type = 'standard' WHERE id = ?",
      });
      expect(
        await checkGroupCapAfterDurationChange(daily.id, group.id),
      ).toBe("2026-10-01");
    });

    test("checkGroupCapAfterDurationChange returns null when the event has no bookings", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const event = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      expect(
        await checkGroupCapAfterDurationChange(event.id, group.id),
      ).toBeNull();
    });

    test("checkGroupCapAfterDurationChange counts legacy null-start_at attendees via the non-daily clause", async () => {
      // A daily group event that had attendees added before it was daily
      // (their start_at is NULL). The SQL counts them via `e.event_type
      // != 'daily'` — but since the event IS daily, they're excluded from
      // the per-day count and don't spuriously trigger an overflow.
      const group = await createTestGroup({ maxAttendees: 10 });
      const event = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      // Book normally (has start_at).
      await bookAttendee(event, { date: "2026-10-01", quantity: 5 });
      // Simulate a legacy attendee with NULL start_at (pre-daily migration).
      const { getDb } = await import("#shared/db/client.ts");
      const { createAttendeeAtomic } = await import(
        "#shared/db/attendees.ts"
      );
      const legacy = await createAttendeeAtomic({
        bookings: [{ eventId: event.id, quantity: 5 }],
        email: "legacy@example.com",
        name: "Legacy",
      });
      if (!legacy.success) throw new Error("setup");
      // Wipe start_at to simulate a pre-migration attendee.
      await getDb().execute({
        args: [legacy.attendees[0]!.id, event.id],
        sql: "UPDATE event_attendees SET start_at = NULL, end_at = NULL WHERE attendee_id = ? AND event_id = ?",
      });
      // The null-start_at row is excluded from per-day counts because the
      // event IS daily — no overflow on day 1 (5 only, not 10).
      expect(
        await checkGroupCapAfterDurationChange(event.id, group.id),
      ).toBeNull();
    });

    test("checkGroupCapAfterDurationChange detects overflow", async () => {
      // Two events in a group with cap 10. Each has 5 attendees on
      // separate days. Extending event A's duration to span event B's
      // day pushes the group total to 10 — at the limit but not over.
      const group = await createTestGroup({ maxAttendees: 10 });
      const eventA = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const eventB = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(eventA, { date: "2026-10-01", quantity: 6 });
      await bookAttendee(eventB, { date: "2026-10-02", quantity: 6 });

      // Before extending: no overlap, group fine.
      expect(
        await checkGroupCapAfterDurationChange(eventA.id, group.id),
      ).toBeNull();

      // Extend event A to 2 days → A now spans day 1+2. Day 2 has
      // A(6) + B(6) = 12 > group cap 10.
      await updateTestEvent(eventA.id, { durationDays: 2 });
      const overDay = await checkGroupCapAfterDurationChange(
        eventA.id,
        group.id,
      );
      expect(overDay).toBe("2026-10-02");
    });

    test("duration change that causes group overflow is detectable", async () => {
      // Use updateTestEvent (full admin form) to change duration, then
      // verify checkGroupCapAfterDurationChange flags the overflow day.
      const group = await createTestGroup({ maxAttendees: 5 });
      const eventA = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const eventB = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(eventA, { date: "2026-11-01", quantity: 3 });
      await bookAttendee(eventB, { date: "2026-11-02", quantity: 3 });

      // Extend eventA to 2 days → day 2 has A(3) + B(3) = 6 > cap 5.
      await updateTestEvent(eventA.id, { durationDays: 2 });
      const overDay = await checkGroupCapAfterDurationChange(
        eventA.id,
        group.id,
      );
      expect(overDay).toBe("2026-11-02");
    });
  });

  describe("public ticket page", () => {
    test("shows booking duration hint for multi-day daily events", async () => {
      const { ticketPage, buildTicketEvent } = await import(
        "#templates/public.tsx"
      );
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 10,
      });
      const fresh = (await getEventWithCount(event.id))!;
      const html = ticketPage({
        dates: ["2026-08-10", "2026-08-11"],
        events: [buildTicketEvent(fresh, false, undefined)],
        slugs: [event.slug],
      });
      expect(html).toContain("each booking reserves 3 days");
    });

    test("no duration hint for single-day daily events", async () => {
      const { ticketPage, buildTicketEvent } = await import(
        "#templates/public.tsx"
      );
      const event = await createDailyTestEvent({ maxAttendees: 10 });
      const fresh = (await getEventWithCount(event.id))!;
      const html = ticketPage({
        dates: ["2026-08-10"],
        events: [buildTicketEvent(fresh, false, undefined)],
        slugs: [event.slug],
      });
      expect(html).not.toContain("each booking reserves");
    });
  });

  describe("admin event detail page", () => {
    test("shows booking duration row for daily events with duration > 1", async () => {
      const { event, cookie } = await setupEventAndLogin({
        durationDays: 3,
        eventType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("Booking Duration");
      expect(html).toContain("3 day(s)");
    });

    test("does not show booking duration for standard events", async () => {
      const { event, cookie } = await setupEventAndLogin();
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("Booking Duration");
    });
  });

  describe("admin event edit page", () => {
    test("edit form pre-fills duration_days and includes warning UI", async () => {
      const { event, cookie } = await setupEventAndLogin({
        durationDays: 5,
        eventType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      const html = await response.text();
      // The duration input is pre-filled with the stored value.
      expect(html).toMatch(/name="duration_days"[^>]*value="5"/);
      // Every element initDurationWarning() hooks into must be present —
      // if any of these IDs change, the client-side gate silently no-ops.
      expect(html).toContain('id="event-edit-form"');
      expect(html).toContain('id="duration-warning"');
      expect(html).toContain('data-duration-original="5"');
      expect(html).toContain('id="duration-warning-confirm"');
      expect(html).toContain('id="event-edit-submit"');
    });
  });

  describe("admin event edit POST", () => {
    /** Minimal valid edit form for a daily event (urlencoded POST). */
    const dailyEditForm = (
      event: { name: string; slug: string },
      durationDays: number,
      groupId = 0,
    ): Record<string, string> => ({
      duration_days: String(durationDays),
      event_type: "daily",
      group_id: String(groupId),
      max_attendees: "100",
      max_quantity: "1",
      name: event.name,
      slug: event.slug,
      thank_you_url: "https://example.com",
    });

    test("changing duration via form updates event and reconciles bookings", async () => {
      const event = await createDailyTestEvent({
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await bookAttendee(event, { date: "2026-09-10" });

      await updateTestEvent(event.id, { durationDays: 4 });

      const fresh = await getEvent(event.id);
      expect(fresh?.duration_days).toBe(4);

      const range = await rawEventRange(event.id);
      expect(range!.end_at).toBe("2026-09-14T00:00:00.000Z");
    });

    test("duration change that overflows the group cap warns in the flash and logs", async () => {
      // Same shape as the checkGroupCapAfterDurationChange unit test, but
      // through the real POST: extending event A to span event B's day pushes
      // the group total to 12 > cap 10 on day 2.
      const group = await createTestGroup({ maxAttendees: 10 });
      const eventA = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const eventB = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(eventA, { date: "2026-10-01", quantity: 6 });
      await bookAttendee(eventB, { date: "2026-10-02", quantity: 6 });

      const { response } = await adminFormPost(
        `/admin/event/${eventA.id}/edit`,
        dailyEditForm(eventA, 2, group.id),
      );
      expectRedirectWithFlash(
        `/admin/event/${eventA.id}`,
        "Event updated Warning: group capacity exceeded on 2026-10-02",
      )(response);

      const messages = (await getEventActivityLog(eventA.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages).toContain(
        `Event '${eventA.name}' duration changed to 2 day(s)`,
      );
      expect(messages).toContain(
        "Duration change caused group capacity overflow on 2026-10-02",
      );
    });

    test("editing a daily event without changing duration leaves ranges and log alone", async () => {
      const event = await createDailyTestEvent({
        durationDays: 2,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await bookAttendee(event, { date: "2026-09-10", durationDays: 2 });
      const before = await rawEventRange(event.id);

      const { response } = await adminFormPost(
        `/admin/event/${event.id}/edit`,
        dailyEditForm(event, 2),
      );
      expectRedirectWithFlash(`/admin/event/${event.id}`, "Event updated")(
        response,
      );

      const after = await rawEventRange(event.id);
      expect(after!.end_at).toBe(before!.end_at);
      const messages = (await getEventActivityLog(event.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages.some((m: string) => m.includes("duration changed"))).toBe(
        false,
      );
    });

    test("changing duration on a standard event does not reconcile or log a duration change", async () => {
      const { event } = await setupEventAndLogin({ maxAttendees: 100 });

      const { response } = await adminFormPost(
        `/admin/event/${event.id}/edit`,
        {
          duration_days: "7",
          max_attendees: "100",
          max_quantity: "1",
          name: event.name,
          slug: event.slug,
          thank_you_url: "https://example.com",
        },
      );
      expectRedirectWithFlash(`/admin/event/${event.id}`, "Event updated")(
        response,
      );

      // The value persists (inert until the event becomes daily)…
      expect((await getEvent(event.id))?.duration_days).toBe(7);
      // …but no reconciliation activity is logged for a standard event.
      const messages = (await getEventActivityLog(event.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages.some((m: string) => m.includes("duration changed"))).toBe(
        false,
      );
    });
  });

  describe("admin REST API", () => {
    test("POST /api/admin/events creates event with duration_days", async () => {
      await assertJson(
        apiRequest("/api/admin/events", {
          body: {
            duration_days: 3,
            event_type: "daily",
            max_attendees: 50,
            name: "API Multi-Day",
          },
          method: "POST",
        }),
        201,
        (body: { event: { duration_days: number; event_type: string } }) => {
          expect(body.event.duration_days).toBe(3);
          expect(body.event.event_type).toBe("daily");
        },
      );
    });

    test("PUT /api/admin/events/:id updates duration_days", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 10 });
      await assertJson(
        apiRequest(`/api/admin/events/${event.id}`, {
          body: { duration_days: 7 },
          method: "PUT",
        }),
        200,
        (body: { event: { duration_days: number } }) => {
          expect(body.event.duration_days).toBe(7);
        },
      );
    });

    test("PUT /api/admin/events/:id preserves duration_days when omitted", async () => {
      const event = await createDailyTestEvent({
        durationDays: 5,
        maxAttendees: 10,
      });
      await assertJson(
        apiRequest(`/api/admin/events/${event.id}`, {
          body: { name: "Renamed" },
          method: "PUT",
        }),
        200,
        (body: { event: { duration_days: number; name: string } }) => {
          expect(body.event.name).toBe("Renamed");
          expect(body.event.duration_days).toBe(5);
        },
      );
    });

    test("POST /api/admin/events clamps out-of-range duration_days", async () => {
      // The admin form validates 1-90, but the JSON API has no form layer —
      // the column-level clamp must bound it (each day adds a clause to the
      // atomic capacity SQL, so an unbounded value is a perf hazard).
      const high = await assertJson<{
        event: { id: number; duration_days: number };
      }>(
        apiRequest("/api/admin/events", {
          body: {
            duration_days: 5000,
            event_type: "daily",
            max_attendees: 50,
            name: "API Clamped High",
          },
          method: "POST",
        }),
        201,
      );
      expect(high.event.duration_days).toBe(MAX_DURATION_DAYS);
      const stored = await getEvent(high.event.id);
      expect(stored?.duration_days).toBe(MAX_DURATION_DAYS);
      await assertJson(
        apiRequest("/api/admin/events", {
          body: {
            duration_days: -2,
            event_type: "daily",
            max_attendees: 50,
            name: "API Clamped Low",
          },
          method: "POST",
        }),
        201,
        (body: { event: { duration_days: number } }) => {
          expect(body.event.duration_days).toBe(1);
        },
      );
    });
  });

  describe("public booking API", () => {
    beforeEach(async () => {
      await settings.update.showPublicApi(true);
    });

    /** Fetch the event's bookable start dates as the public API reports them. */
    const fetchAvailableDates = async (slug: string): Promise<string[]> => {
      const body = await assertJson<{
        event: { availableDates: string[] };
      }>(apiRequest(`/api/events/${slug}`), 200);
      return body.event.availableDates;
    };

    test("POST /api/events/:slug/book on a 3-day event stores a 3-day range", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });
      const dates = await fetchAvailableDates(event.slug);
      expect(dates.length).toBeGreaterThan(0);

      await assertJson(
        apiRequest(`/api/events/${event.slug}/book`, {
          body: {
            date: dates[0],
            email: "multi@test.com",
            name: "Multi Day",
          },
          method: "POST",
        }),
        200,
        (body: { ticketToken?: string }) => {
          expect(body.ticketToken).toBeDefined();
        },
      );

      const range = await rawEventRange(event.id);
      expect(range!.start_at).toBe(`${dates[0]}T00:00:00Z`);
      const expectedEnd = new Date(
        new Date(`${dates[0]}T00:00:00Z`).getTime() + 3 * 86_400_000,
      ).toISOString();
      expect(range!.end_at).toBe(expectedEnd);
    });

    test("availability and booking reject a start date whose middle day is full", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 2,
      });
      const dates = await fetchAvailableDates(event.slug);
      const start = dates[0]!;
      const middle = addDays(start, 1);
      await bookAttendee(event, { date: middle, durationDays: 1, quantity: 2 });

      await assertJson(
        apiRequest(
          `/api/events/${event.slug}/availability?date=${start}&quantity=1`,
        ),
        200,
        (body: { available: boolean }) => {
          expect(body.available).toBe(false);
        },
      );

      await assertJson(
        apiRequest(`/api/events/${event.slug}/book`, {
          body: { date: start, email: "blocked@test.com", name: "Blocked" },
          method: "POST",
        }),
        409,
      );
    });
  });

  describe("admin CSV export via HTTP", () => {
    test("GET /admin/event/:id/export includes date range for multi-day", async () => {
      const { event, cookie } = await setupEventAndLogin({
        durationDays: 3,
        eventType: "daily",
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      await bookAttendee(event, { date: "2026-06-12", durationDays: 3 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).toContain("2026-06-12 to 2026-06-14");
    });
  });

  describe("admin attendee detail page", () => {
    test("shows date range for multi-day booking in event links table", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 10,
      });
      const result = await bookAttendee(event, {
        date: "2026-07-15",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const { cookie } = await setupEventAndLogin();
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendees[0]!.id}`,
        { cookie },
      );
      const html = await response.text();
      // Should show the range label, not just the start date.
      expect(html).toContain("15");
      expect(html).toContain("17");
      expect(html).toContain("July");
    });
  });

  describe("admin attendee check-in on multi-day booking", () => {
    test("check-in works for attendee with multi-day booking", async () => {
      const { handleRequest } = await import("#routes");
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      const result = await bookAttendee(event, {
        date: "2026-08-01",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${result.attendees[0]!.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const attendees = await getAttendeesRaw(event.id);
      const checkedIn = attendees.find((a) => a.id === result.attendees[0]!.id);
      expect(Boolean(checkedIn?.checked_in)).toBe(true);
    });
  });

  describe("edge cases: realistic unusual scenarios", () => {
    test("1a: qty > 1 multi-day bookings aggregate per-day demand correctly", async () => {
      // Two bookings of qty=2 on a 3-day event (cap 5). Each day sees 2+2=4 ≤ 5.
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });
      await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      const b = await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      expect(b.success).toBe(true);
    });

    test("1b: qty > 1 multi-day booking rejected when per-day total exceeds cap", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });
      await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      // Third: 2+2+2=6 > 5 on every day → reject.
      const c = await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      expect(c.success).toBe(false);
    });

    test("2: bookable_days change does not corrupt existing bookings", async () => {
      // Book a 3-day range Mon-Tue-Wed, then admin removes Tuesday from bookable_days.
      // Existing booking stays in the DB. New bookings covering Tuesday are blocked.
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      // Book starting 2026-06-08 (Mon) → covers Mon, Tue, Wed.
      await bookAttendee(event, { date: "2026-06-08", durationDays: 3 });

      // Admin removes Tuesday from bookable days.
      await updateTestEvent(event.id, {
        bookableDays: [
          "Monday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
      });

      // The old booking still occupies those days in the DB.
      const range = await rawEventRange(event.id);
      expect(range).not.toBeNull();

      // New bookings starting on Monday should be blocked because the range
      // would include Tuesday (now non-bookable).
      const fresh = (await getEventWithCount(event.id))!;
      const holidays = await getActiveHolidays();
      const dates = getAvailableDates(fresh, holidays);
      // A start date that would require Tuesday should not appear.
      // 2026-06-08 is Monday → 3-day range hits Tuesday → excluded.
      expect(dates).not.toContain("2026-06-08");
    });

    test("3: duration increase extends booking past maximum_days_after (allowed, existing booking)", async () => {
      // An existing booking was valid when created. Admin extends duration.
      // The stored end_at now extends past the booking window — the system
      // allows this for existing bookings (they were booked in good faith).
      const event = await createDailyTestEvent({
        durationDays: 1,
        maxAttendees: 5,
        maximumDaysAfter: 10,
      });
      // Book on day 9 (within the 10-day window).
      await bookAttendee(event, { date: "2026-06-09" });
      // Extend to 5 days → end_at is now day 14, past the window.
      await updateTestEvent(event.id, { durationDays: 5 });
      const range = await rawEventRange(event.id);
      expect(range!.end_at).toBe("2026-06-14T00:00:00.000Z");
      // But no new bookings should be offered on day 9 since the range
      // would extend to day 14, past the window.
      const fresh = (await getEventWithCount(event.id))!;
      const dates = getAvailableDates(fresh, await getActiveHolidays());
      expect(dates).not.toContain("2026-06-09");
    });

    test("4: concurrent at-capacity multi-day bookings — only one wins", async () => {
      const event = await createDailyTestEvent({
        durationDays: 2,
        maxAttendees: 1,
      });
      const [a, b] = await Promise.all([
        bookAttendee(event, {
          date: "2026-06-12",
          durationDays: 2,
          email: "a@test.com",
        }),
        bookAttendee(event, {
          date: "2026-06-12",
          durationDays: 2,
          email: "b@test.com",
        }),
      ]);
      const winners = [a.success, b.success].filter(Boolean);
      expect(winners.length).toBe(1);
    });

    test("5: unlink multi-day booking and re-add on same event/date", async () => {
      const event = await createDailyTestEvent({
        durationDays: 3,
        maxAttendees: 5,
      });
      const event2 = await createDailyTestEvent({ maxAttendees: 5 });

      // Book attendee on two events (so unlinking one doesn't delete attendee).
      const result = await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-07-01",
            durationDays: 3,
            eventId: event.id,
            quantity: 1,
          },
          { date: "2026-07-01", eventId: event2.id, quantity: 1 },
        ],
        email: "relink@test.com",
        name: "Relink",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const attendeeId = result.attendees[0]!.id;

      // Unlink from the multi-day event.
      const { addEventLink } = await import("#shared/db/attendees.ts");
      await unlinkAttendeeFromEvent(attendeeId, event.id);
      expect((await getAttendeesRaw(event.id)).length).toBe(0);

      // Re-add same event/date — should succeed (old row is deleted).
      const relink = await addEventLink(attendeeId, {
        date: "2026-07-01",
        durationDays: 3,
        eventId: event.id,
        quantity: 1,
      });
      expect(relink.success).toBe(true);
      const range = await rawEventRange(event.id);
      expect(range!.end_at).toBe("2026-07-04T00:00:00.000Z");
    });

    test("6: group cart with mismatched durations rejects when overlap days exceed cap", async () => {
      // EventA is 2-day, EventB is 4-day. Both in same group with cap=3.
      // Cart: qty=2 each → overlap on days 1-2 sees 4 > 3.
      const group = await createTestGroup({ maxAttendees: 3 });
      const eventA = await createDailyTestEvent({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
      });
      const eventB = await createDailyTestEvent({
        durationDays: 4,
        groupId: group.id,
        maxAttendees: 100,
      });

      expect(
        await checkBatchAvailability(
          [
            { durationDays: 2, eventId: eventA.id, quantity: 2 },
            { durationDays: 4, eventId: eventB.id, quantity: 2 },
          ],
          "2026-08-01",
        ),
      ).toBe(false);
    });

    test("7: admin qty increase on multi-day booking rejected when one day overflows", async () => {
      const event = await createDailyTestEvent({
        durationDays: 2,
        maxAttendees: 5,
      });
      const x = await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 2,
        quantity: 2,
      });
      if (!x.success) throw new Error("setup");
      await bookAttendee(event, {
        date: "2026-06-12",
        durationDays: 1,
        quantity: 2,
      });
      // Day 12: X(2) + other(2) = 4. Admin bumps X to 4 → 4+2=6 > 5.
      const { updateEventLink } = await import("#shared/db/attendees.ts");
      const result = await updateEventLink(x.attendees[0]!.id, event.id, {
        date: "2026-06-12",
        durationDays: 2,
        quantity: 4,
      });
      expect(result.success).toBe(false);
    });

    test("8: admin date move where old and new ranges do not overlap", async () => {
      // Booking at cap on days 1-2. Move to days 10-11 (completely disjoint).
      // Self-exclusion must remove the old row from both old and new capacity.
      const event = await createDailyTestEvent({
        durationDays: 2,
        maxAttendees: 1,
      });
      const result = await bookAttendee(event, {
        date: "2026-06-01",
        durationDays: 2,
      });
      if (!result.success) throw new Error("setup");

      const { updateEventLink } = await import("#shared/db/attendees.ts");
      const moved = await updateEventLink(result.attendees[0]!.id, event.id, {
        date: "2026-06-10",
        durationDays: 2,
        quantity: 1,
      });
      expect(moved.success).toBe(true);

      // Old dates free, new dates occupied.
      expect(await hasAvailableSpots(event.id, 1, "2026-06-01", 2)).toBe(true);
      expect(await hasAvailableSpots(event.id, 1, "2026-06-10", 2)).toBe(false);
    });

    test("9: event type switch from standard to daily preserves existing attendees", async () => {
      // Standard event gets attendees, then admin switches to daily.
      // Existing attendees have null start_at/end_at (no date).
      // They should still count toward total capacity.
      const event = await createDailyTestEvent({
        eventType: "standard",
        maxAttendees: 2,
        maximumDaysAfter: 30,
      });
      await bookAttendee(event, { quantity: 2 });

      // Switch to daily + duration 2.
      await updateTestEvent(event.id, { durationDays: 2, eventType: "daily" });

      // The 2 existing attendees (no date) should still block capacity.
      // hasAvailableSpots with no date checks total.
      expect(await hasAvailableSpots(event.id, 1)).toBe(false);
    });

    test("10: duration longer than booking window yields fewer available dates", async () => {
      // duration=5, maximum_days_after=7. The 5-day range must fit in
      // the 7-day window, so only ~3 start dates are possible. A 1-day
      // event with the same window would have ~7.
      const long = await createDailyTestEvent({
        durationDays: 5,
        maxAttendees: 10,
        maximumDaysAfter: 7,
      });
      const short = await createDailyTestEvent({
        durationDays: 1,
        maxAttendees: 10,
        maximumDaysAfter: 7,
      });
      const holidays = await getActiveHolidays();
      const longDates = getAvailableDates(
        (await getEventWithCount(long.id))!,
        holidays,
      );
      const shortDates = getAvailableDates(
        (await getEventWithCount(short.id))!,
        holidays,
      );
      expect(shortDates.length).toBeGreaterThan(longDates.length);
      expect(longDates.length).toBeGreaterThan(0);
    });

    test("checkGroupCapAfterDurationChange sort comparator with equal-start ranges", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const event = await createDailyTestEvent({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(event, { date: "2026-10-01", quantity: 3 });
      await bookAttendee(event, { date: "2026-10-01", quantity: 4 });
      const result = await checkGroupCapAfterDurationChange(
        event.id,
        group.id,
      );
      expect(result).toBeNull();
    });
  });
});
