import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#lib/dates.ts";
import { sortEvents } from "#lib/sort-events.ts";
import { todayInTz } from "#lib/timezone.ts";
import type { EventWithCount, Holiday } from "#lib/types.ts";
import { describeWithEnv, testEvent, testEventWithCount } from "#test-utils";

const today = () => todayInTz("UTC");

/** Create Bravo/Alpha pair, sort, and assert Alpha comes first */
const expectAlphaBeforeBravo = (
  overrides: Partial<Parameters<typeof testEvent>[0]>,
) => {
  const b = testEvent({ id: 1, name: "Bravo", ...overrides });
  const a = testEvent({ id: 2, name: "Alpha", ...overrides });
  const sorted = sortEvents([b, a], []);
  expect(sorted[0]!.name).toBe("Alpha");
  expect(sorted[1]!.name).toBe("Bravo");
};

describeWithEnv("sortEvents", { db: true }, () => {
  test("returns empty array for empty input", () => {
    expect(sortEvents([], [])).toEqual([]);
  });

  test("returns single event unchanged", () => {
    const event = testEvent({ name: "Solo" });
    expect(sortEvents([event], [])).toEqual([event]);
  });

  test("places no-date standard events before dated standard events", () => {
    const noDate = testEvent({
      date: "",
      event_type: "standard",
      id: 1,
      name: "Undated",
    });
    const dated = testEvent({
      date: "2026-06-15T14:00:00.000Z",
      event_type: "standard",
      id: 2,
      name: "Dated",
    });

    const sorted = sortEvents([dated, noDate], []);
    expect(sorted[0]!.name).toBe("Undated");
    expect(sorted[1]!.name).toBe("Dated");
  });

  test("places dated standard events before daily events", () => {
    const dated = testEvent({
      date: "2026-06-15T14:00:00.000Z",
      event_type: "standard",
      id: 1,
      name: "Dated",
    });
    const daily = testEvent({ event_type: "daily", id: 2, name: "Daily" });

    const sorted = sortEvents([daily, dated], []);
    expect(sorted[0]!.name).toBe("Dated");
    expect(sorted[1]!.name).toBe("Daily");
  });

  test("places no-date standard before daily events", () => {
    const noDate = testEvent({
      date: "",
      event_type: "standard",
      id: 1,
      name: "Undated",
    });
    const daily = testEvent({ event_type: "daily", id: 2, name: "Daily" });

    const sorted = sortEvents([daily, noDate], []);
    expect(sorted[0]!.name).toBe("Undated");
    expect(sorted[1]!.name).toBe("Daily");
  });

  test("sorts no-date standard events alphabetically by name", () => {
    const c = testEvent({
      date: "",
      event_type: "standard",
      id: 1,
      name: "Charlie",
    });
    const a = testEvent({
      date: "",
      event_type: "standard",
      id: 2,
      name: "Alpha",
    });
    const b = testEvent({
      date: "",
      event_type: "standard",
      id: 3,
      name: "Bravo",
    });

    const sorted = sortEvents([c, a, b], []);
    expect(sorted.map((e) => e.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("sorts dated standard events by date ascending", () => {
    const later = testEvent({
      date: "2026-09-01T10:00:00.000Z",
      event_type: "standard",
      id: 1,
      name: "Later",
    });
    const earlier = testEvent({
      date: "2026-06-15T14:00:00.000Z",
      event_type: "standard",
      id: 2,
      name: "Earlier",
    });

    const sorted = sortEvents([later, earlier], []);
    expect(sorted[0]!.name).toBe("Earlier");
    expect(sorted[1]!.name).toBe("Later");
  });

  test("sorts dated standard events by name when dates are equal", () => {
    expectAlphaBeforeBravo({
      date: "2026-06-15T14:00:00.000Z",
      event_type: "standard",
    });
  });

  test("sorts daily events by next bookable date ascending", () => {
    const laterDaily = testEvent({
      event_type: "daily",
      id: 1,
      maximum_days_after: 30,
      minimum_days_before: 5,
      name: "Later Daily",
    });
    const soonerDaily = testEvent({
      event_type: "daily",
      id: 2,
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Sooner Daily",
    });

    const sorted = sortEvents([laterDaily, soonerDaily], []);
    expect(sorted[0]!.name).toBe("Sooner Daily");
    expect(sorted[1]!.name).toBe("Later Daily");
  });

  test("sorts daily events by name when next bookable dates are equal", () => {
    const b = testEvent({
      event_type: "daily",
      id: 1,
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Bravo Daily",
    });
    const a = testEvent({
      event_type: "daily",
      id: 2,
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Alpha Daily",
    });
    const sorted = sortEvents([b, a], []);
    expect(sorted[0]!.name).toBe("Alpha Daily");
    expect(sorted[1]!.name).toBe("Bravo Daily");
  });

  test("places daily events with no bookable dates after those with dates", () => {
    const hasBookable = testEvent({
      event_type: "daily",
      id: 1,
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "Has Dates",
    });
    const noBookable = testEvent({
      bookable_days: [],
      event_type: "daily",
      id: 2,
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "No Dates",
    });

    const sorted = sortEvents([noBookable, hasBookable], []);
    expect(sorted[0]!.name).toBe("Has Dates");
    expect(sorted[1]!.name).toBe("No Dates");
  });

  test("sorts daily events with no bookable dates by name", () => {
    expectAlphaBeforeBravo({ bookable_days: [], event_type: "daily" });
  });

  test("places daily event with bookable dates before one without regardless of input order", () => {
    const withDates = testEvent({
      event_type: "daily",
      id: 1,
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "With Dates",
    });
    const withoutDates = testEvent({
      bookable_days: [],
      event_type: "daily",
      id: 2,
      name: "Without Dates",
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
    const holidays: Holiday[] = [
      {
        end_date: addDays(todayStr, 5),
        id: 1,
        name: "Holiday",
        start_date: addDays(todayStr, 1),
      },
    ];

    const blockedEvent = testEvent({
      event_type: "daily",
      id: 1,
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Blocked",
    });
    const freeEvent = testEvent({
      event_type: "daily",
      id: 2,
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "Free",
    });

    const sorted = sortEvents([blockedEvent, freeEvent], holidays);
    expect(sorted[0]!.name).toBe("Free");
    expect(sorted[1]!.name).toBe("Blocked");
  });

  test("sorts a mixed list of all three event types correctly", () => {
    const daily = testEvent({
      event_type: "daily",
      id: 1,
      minimum_days_before: 0,
      name: "Daily Event",
    });
    const datedStandard = testEvent({
      date: "2026-06-15T14:00:00.000Z",
      event_type: "standard",
      id: 2,
      name: "Dated Standard",
    });
    const nodateStandard = testEvent({
      date: "",
      event_type: "standard",
      id: 3,
      name: "No-Date Standard",
    });

    const sorted = sortEvents([daily, datedStandard, nodateStandard], []);
    expect(sorted.map((e) => e.name)).toEqual([
      "No-Date Standard",
      "Dated Standard",
      "Daily Event",
    ]);
  });

  test("preserves EventWithCount fields", () => {
    const event = testEventWithCount({
      attendee_count: 42,
      id: 1,
      name: "Test",
    });
    const sorted = sortEvents([event], []);
    expect((sorted[0] as EventWithCount).attendee_count).toBe(42);
  });
});
