import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Holiday, HolidayInput } from "#db/holidays.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { defineRecord, type RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { okResult } from "#shared/result.ts";

type HolidayShape = RecordShapeOf<Holiday, HolidayInput>;
const holidayFields = {
  activityName: "Holiday",
  getAll: () => Promise.resolve([] as Holiday[]),
  list: "holidays",
  logName: (input: HolidayInput) => input.name,
  nameOf: (row: Holiday) => row.name,
  rule: (input: HolidayInput) => okResult(input),
  surface: "holidays",
} as const;

test("refuses a record with no JSON resource", () => {
  const record = defineRecord<HolidayShape>(holidayFields);
  expect(() =>
    recordApi<typeof ADMIN_API_RESOURCES.holidays, HolidayShape>(
      record,
      {} as never,
    ),
  ).toThrow("The record for holidays declares no JSON resource");
});

test("refuses a record with no display-name column", () => {
  const record = defineRecord<HolidayShape>({
    ...holidayFields,
    api: ADMIN_API_RESOURCES.holidays,
  });
  expect(() =>
    recordApi<typeof ADMIN_API_RESOURCES.holidays, HolidayShape>(
      record,
      {} as never,
    ),
  ).toThrow("The Holiday record names no display-name column");
});
