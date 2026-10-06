/** The holiday input assembly and its date reads. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holidayInput, readDates } from "#routes/admin/holiday-input.ts";
import { parseDateStringOrThrow } from "#shared/validation/date.ts";

describe("holiday input", () => {
  test("assembles the stored name and cleaned date range", () => {
    expect(
      holidayInput("Summer Break", {
        endDate: parseDateStringOrThrow(
          "2026-08-31",
          "the assembled holiday end date",
        ),
        startDate: parseDateStringOrThrow(
          "2026-07-01",
          "the assembled holiday start date",
        ),
      }),
    ).toEqual({
      endDate: "2026-08-31",
      name: "Summer Break",
      startDate: "2026-07-01",
    });
  });

  test("create reads both dates as required", () => {
    const missing = readDates({ end_date: "2026-08-31" }, null);
    expect(missing).toEqual({ error: "start_date is required", ok: false });

    const unusable = readDates(
      { end_date: "2026-08-31", start_date: "2026-7-1" },
      null,
    );
    expect(unusable).toEqual({
      error: "start_date has an invalid value",
      ok: false,
    });

    const clean = readDates(
      { end_date: " 2026-08-31 ", start_date: " 2026-07-01 " },
      null,
    );
    expect(clean).toEqual({
      ok: true,
      value: { endDate: "2026-08-31", startDate: "2026-07-01" },
    });
  });

  test("update falls back to the stored dates and refuses unusable ones", () => {
    const stored = { end_date: "2026-08-31", start_date: "2026-07-01" };

    const fallback = readDates({}, stored);
    expect(fallback).toEqual({
      ok: true,
      value: { endDate: "2026-08-31", startDate: "2026-07-01" },
    });

    const rollover = readDates({ start_date: "2027-02-30" }, stored);
    expect(rollover).toEqual({
      error: "start_date has an invalid value",
      ok: false,
    });

    const replaced = readDates(
      { end_date: "2026-09-30", start_date: "2026-09-01" },
      stored,
    );
    expect(replaced).toEqual({
      ok: true,
      value: { endDate: "2026-09-30", startDate: "2026-09-01" },
    });
  });
});
