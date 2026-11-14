import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holidayRecord, holidayRule } from "#shared/records/holidays.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";

const holidayInput = (name: string, start: string, end: string) => ({
  endDate: parseDateStringOrThrow(end, "the holiday end date"),
  name,
  startDate: parseDateStringOrThrow(start, "the holiday start date"),
});

const summerRow = {
  end_date: "2026-07-02",
  id: 1,
  name: "Summer",
  start_date: "2026-07-01",
};

describe("the holiday rule", () => {
  test("refuses an end date before the start date", () => {
    expect(
      holidayRule(holidayInput("Back", "2026-06-02", "2026-06-01")),
    ).toEqual({
      error: "End date must be on or after the start date",
      ok: false,
    });
  });

  test("accepts one day, where the two dates are equal", () => {
    const input = holidayInput("One day", "2026-06-01", "2026-06-01");

    expect(holidayRule(input)).toEqual({ ok: true, value: input });
  });

  test("accepts an end date after the start date", () => {
    const input = holidayInput("Two days", "2026-06-01", "2026-06-02");

    expect(holidayRule(input)).toEqual({ ok: true, value: input });
  });
});

describe("the holiday record's declaration", () => {
  test("asks for the holiday name on its delete page", () => {
    expect(deleteConfirmLabel(holidayRecord)).toBe("Holiday name");
  });
});

describeWithEnv("the holiday record's commands", { db: true }, () => {
  test("creates a holiday and logs it with the holiday name", async () => {
    const input = holidayInput("Summer", "2026-07-01", "2026-07-02");

    expect(await holidayRecord.create(input)).toEqual({
      kind: "written",
      row: summerRow,
    });
    expect(await activityMessages()).toEqual(["Holiday 'Summer' created"]);
    expect(await holidayRecord.getAll()).toEqual([summerRow]);
  });
});
