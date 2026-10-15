import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveSharedDates } from "#routes/admin/attendee-form-model.ts";
import { bookingRow } from "#test-utils/factories.ts";

describe("resolveSharedDates", () => {
  const addDaysIso = (date: string, n: number): string => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const daily = (start: string, durationDays: number) =>
    bookingRow({
      end_at: `${addDaysIso(start, durationDays)}T00:00:00.000Z`,
      start_at: `${start}T00:00:00Z`,
    });

  test("returns empty defaults when there are no dated bookings", () => {
    const result = resolveSharedDates([bookingRow({ start_at: null })]);
    expect(result).toEqual({
      dayCount: 1,
      hasMixedTimings: false,
      startDate: "",
    });
  });

  test("returns the shared range when bookings agree", () => {
    const result = resolveSharedDates([
      daily("2026-06-14", 1),
      daily("2026-06-14", 1),
    ]);
    expect(result.hasMixedTimings).toBe(false);
    expect(result.startDate).toBe("2026-06-14");
    expect(result.dayCount).toBe(1);
  });

  test("flags mixed start dates, seeding earliest start + longest length", () => {
    const result = resolveSharedDates([
      daily("2026-07-01", 1),
      daily("2026-06-14", 3),
    ]);
    expect(result.hasMixedTimings).toBe(true);
    expect(result.startDate).toBe("2026-06-14");
    expect(result.dayCount).toBe(3);
  });

  test("flags mixed durations", () => {
    const result = resolveSharedDates([
      daily("2026-06-14", 1),
      daily("2026-06-14", 3),
    ]);
    expect(result.hasMixedTimings).toBe(true);
  });

  test("ignores a booking with no end date", () => {
    const result = resolveSharedDates([
      bookingRow({ end_at: null, start_at: "2026-06-14T00:00:00Z" }),
    ]);
    expect(result.startDate).toBe("");
  });

  test("falls back to length 1 for a dated but zero-length booking", () => {
    // Both endpoints present (so it passes the filter) but the range is empty,
    // so the per-booking duration is null and defaults to 1.
    const result = resolveSharedDates([daily("2026-06-14", 0)]);
    expect(result.startDate).toBe("2026-06-14");
    expect(result.dayCount).toBe(1);
    expect(result.hasMixedTimings).toBe(false);
  });
});
