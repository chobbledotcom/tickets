import { expect } from "@std/expect";
import { DAY_NAMES, VALID_DAY_NAMES } from "#shared/day-names.ts";

Deno.test("bookable day names rotate the date order to Monday first", () => {
  expect(DAY_NAMES).toEqual([
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]);
  expect(VALID_DAY_NAMES).toEqual([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
});
