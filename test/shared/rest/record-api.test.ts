import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { holidayRecord } from "#shared/records/holidays.ts";
import { recordApi } from "#shared/rest/record-api.ts";

test("refuses a record with no JSON resource", () => {
  expect(() =>
    recordApi(
      { ...holidayRecord, api: undefined } as unknown as Parameters<
        typeof recordApi
      >[0],
      {} as never,
    ),
  ).toThrow("The record for holidays declares no JSON resource");
});

test("refuses a record with no display-name column", () => {
  expect(() =>
    recordApi(
      {
        ...holidayRecord,
        nameField: undefined,
      } as unknown as Parameters<typeof recordApi>[0],
      {} as never,
    ),
  ).toThrow("The Holiday record names no display-name column");
});
