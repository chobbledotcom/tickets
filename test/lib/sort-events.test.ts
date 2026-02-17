import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { addDays } from "#lib/dates.ts";
import { updateTimezone } from "#lib/db/settings.ts";
import { sortEvents } from "#lib/sort-events.ts";
import { todayInTz } from "#lib/timezone.ts";
import type { EventWithCount, Holiday } from "#lib/types.ts";
import { createTestDbWithSetup, resetDb, testEvent, testEventWithCount } from "#test-utils";

const today = () => todayInTz("UTC");

describe("sortEvents", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
    await updateTimezone("UTC");
  });

  afterEach(() => {
    resetDb();
  });

  test("returns empty array for empty input", () => {
    expect(sortEvents([], [])).toEqual([]);
  });

  test("returns single event unchanged", () => {
    const event = testEvent({ name: "Solo" });
    expect(sortEvents([event], [])).toEqual([event]);
  });

  test("places no-date standard events before dated standard events", () => {
    const noDate = testEvent({ id: 1, name: "Undated", event_type: "standard", date: "" });
    const dated = testEvent({ id: 2, name: "Dated", event_type: "standard", date: "2026-06-15T14:00:00.000Z" });

    const sorted = sortEvents([dated, noDate], []);
    expect(sorted[0]!.name).toBe("Undated");
    expect(sorted[1]!.name).toBe("Dated");
  });

  test("places dated standard events before daily events", () => {
    const dated = testEvent({ id: 1, name: "Dated", event_type: "standard", date: "2026-06-15T14:00:00.000Z" });
    const daily = testEvent({ id: 2, name: "Daily", event_type: "daily" });

    const sorted = sortEvents([daily, dated], []);
    expect(sorted[0]!.name).toBe("Dated");
    expect(sorted[1]!.name).toBe("Daily");
  });

  test("places no-date standard before daily events", () => {
    const noDate = testEvent({ id: 1, name: "Undated", event_type: "standard", date: "" });
    const daily = testEvent({ id: 2, name: "Daily", event_type: "daily" });

    const sorted = sortEvents([daily, noDate], []);
    expect(sorted[0]!.name).toBe("Undated");
    expect(sorted[1]!.name).toBe("Daily");
  });

  test("sorts no-date standard events alphabetically by name", () => {
    const c = testEvent({ id: 1, name: "Charlie", event_type: "standard", date: "" });
    const a = testEvent({ id: 2, name: "Alpha", event_type: "standard", date: "" });
    const b = testEvent({ id: 3, name: "Bravo", event_type: "standard", date: "" });

    const sorted = sortEvents([c, a, b], []);
    expect(sorted.map((e) => e.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("sorts dated standard events by date ascending", () => {
    const later = testEvent({ id: 1, name: "Later", event_type: "standard", date: "2026-09-01T10:00:00.000Z" });
    const earlier = testEvent({ id: 2, name: "Earlier", event_type: "standard", date: "2026-06-15T14:00:00.000Z" });

    const sorted = sortEvents([later, earlier], []);
    expect(sorted[0]!.name).toBe("Earlier");
    expect(sorted[1]!.name).toBe("Later");
  });

  test("sorts dated standard events by name when dates are equal", () => {
    const b = testEvent({ id: 1, name: "Bravo", event_type: "standard", date: "2026-06-15T14:00:00.000Z" });
    const a = testEvent({ id: 2, name: "Alpha", event_type: "standard", date: "2026-06-15T14:00:00.000Z" });

    const sorted = sortEvents([b, a], []);
    expect(sorted[0]!.name).toBe("Alpha");
    expect(sorted[1]!.name).toBe("Bravo");
  });

  test("sorts daily events by next bookable date ascending", () => {
    const laterDaily = testEvent({
      id: 1,
      name: "Later Daily",
      event_type: "daily",
      minimum_days_before: 5,
      maximum_days_after: 30,
    });
    const soonerDaily = testEvent({
      id: 2,
      name: "Sooner Daily",
      event_type: "daily",
      minimum_days_before: 1,
      maximum_days_after: 30,
    });

    const sorted = sortEvents([laterDaily, soonerDaily], []);
    expect(sorted[0]!.name).toBe("Sooner Daily");
    expect(sorted[1]!.name).toBe("Later Daily");
  });

  test("sorts daily events by name when next bookable dates are equal", () => {
    const b = testEvent({
      id: 1,
      name: "Bravo Daily",
      event_type: "daily",
      minimum_days_before: 1,
      maximum_days_after: 30,
    });
    const a = testEvent({
      id: 2,
      name: "Alpha Daily",
      event_type: "daily",
      minimum_days_before: 1,
      maximum_days_after: 30,
    });

    const sorted = sortEvents([b, a], []);
    expect(sorted[0]!.name).toBe("Alpha Daily");
    expect(sorted[1]!.name).toBe("Bravo Daily");
  });

  test("places daily events with no bookable dates after those with dates", () => {
    const hasBookable = testEvent({
      id: 1,
      name: "Has Dates",
      event_type: "daily",
      minimum_days_before: 0,
      maximum_days_after: 30,
    });
    const noBookable = testEvent({
      id: 2,
      name: "No Dates",
      event_type: "daily",
      bookable_days: JSON.stringify([]),
      minimum_days_before: 0,
      maximum_days_after: 30,
    });

    const sorted = sortEvents([noBookable, hasBookable], []);
    expect(sorted[0]!.name).toBe("Has Dates");
    expect(sorted[1]!.name).toBe("No Dates");
  });

  test("sorts daily events with no bookable dates by name", () => {
    const b = testEvent({
      id: 1,
      name: "Bravo",
      event_type: "daily",
      bookable_days: JSON.stringify([]),
    });
    const a = testEvent({
      id: 2,
      name: "Alpha",
      event_type: "daily",
      bookable_days: JSON.stringify([]),
    });

    const sorted = sortEvents([b, a], []);
    expect(sorted[0]!.name).toBe("Alpha");
    expect(sorted[1]!.name).toBe("Bravo");
  });

  test("places daily event with bookable dates before one without regardless of input order", () => {
    const withDates = testEvent({
      id: 1,
      name: "With Dates",
      event_type: "daily",
      minimum_days_before: 0,
      maximum_days_after: 30,
    });
    const withoutDates = testEvent({
      id: 2,
      name: "Without Dates",
      event_type: "daily",
      bookable_days: JSON.stringify([]),
    });

    // Test both input orderings to exercise both dateA="" and dateB="" branches
    const sorted1 = sortEvents([withDates, withoutDates], []);
    expect(sorted1[0]!.name).toBe("With Dates");

    const sorted2 = sortEvents([withoutDates, withDates], []);
    expect(sorted2[0]!.name).toBe("With Dates");
  });

  test("accounts for holidays when sorting daily events", () => {
    const todayStr = today();
    // Block the next few days so event A's first bookable date is pushed later
    const holidays: Holiday[] = [{
      id: 1,
      name: "Holiday",
      start_date: addDays(todayStr, 1),
      end_date: addDays(todayStr, 5),
    }];

    const blockedEvent = testEvent({
      id: 1,
      name: "Blocked",
      event_type: "daily",
      minimum_days_before: 1,
      maximum_days_after: 30,
    });
    const freeEvent = testEvent({
      id: 2,
      name: "Free",
      event_type: "daily",
      minimum_days_before: 0,
      maximum_days_after: 30,
    });

    const sorted = sortEvents([blockedEvent, freeEvent], holidays);
    expect(sorted[0]!.name).toBe("Free");
    expect(sorted[1]!.name).toBe("Blocked");
  });

  test("sorts a mixed list of all three event types correctly", () => {
    const daily = testEvent({ id: 1, name: "Daily Event", event_type: "daily", minimum_days_before: 0 });
    const datedStandard = testEvent({ id: 2, name: "Dated Standard", event_type: "standard", date: "2026-06-15T14:00:00.000Z" });
    const nodateStandard = testEvent({ id: 3, name: "No-Date Standard", event_type: "standard", date: "" });

    const sorted = sortEvents([daily, datedStandard, nodateStandard], []);
    expect(sorted.map((e) => e.name)).toEqual([
      "No-Date Standard",
      "Dated Standard",
      "Daily Event",
    ]);
  });

  test("preserves EventWithCount fields", () => {
    const event = testEventWithCount({ id: 1, name: "Test", attendee_count: 42 });
    const sorted = sortEvents([event], []);
    expect((sorted[0] as EventWithCount).attendee_count).toBe(42);
  });
});
