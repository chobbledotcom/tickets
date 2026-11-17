import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { holidayRecord, holidayRule } from "#shared/records/holidays.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeRecord } from "#test-utils/record-labels.ts";
import { describeRuleCases } from "#test-utils/rule-cases.ts";

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

describeRuleCases("the holiday rule", holidayRule, [
  [
    "refuses an end date before the start date",
    holidayInput("Break", "2026-06-02", "2026-06-01"),
    "End date must be on or after the start date",
  ],
  [
    "accepts one day, where the two dates are equal",
    holidayInput("Break", "2026-06-01", "2026-06-01"),
    null,
  ],
  [
    "accepts an end date after the start date",
    holidayInput("Break", "2026-06-01", "2026-06-02"),
    null,
  ],
]);

describeRecord(holidayRecord, "Holiday", "Holiday name", () => {
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
