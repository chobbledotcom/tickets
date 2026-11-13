/** The body and form reads one field list declares, shown on the holiday
 *  fields. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Holiday, HolidayInput } from "#db/holidays.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { bodyMappers, formInput } from "#shared/rest/field-reads.ts";
import type { DateString } from "#shared/validation/date-string.ts";

/** True when the two types are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const { toCreateInput, toUpdateInput } = bodyMappers(HOLIDAY_FIELDS);

const stored = {
  end_date: "2026-08-31",
  id: 1,
  name: "Summer Break",
  start_date: "2026-07-01",
};

describe("field reads", () => {
  test("the row and the input follow the field list", () => {
    const shapes: [
      Same<
        Holiday,
        { end_date: string; id: number; name: string; start_date: string }
      >,
      Same<
        HolidayInput,
        { endDate: DateString; name: string; startDate: DateString }
      >,
    ] = [true, true];
    expect(shapes).toEqual([true, true]);
  });

  test("a create reads every field as required, in declaration order", () => {
    const refusals: readonly [Record<string, string>, string][] = [
      [{ end_date: "2026-08-31" }, "name cannot be empty"],
      [{ end_date: "2026-08-31", name: "Summer" }, "start_date is required"],
      [
        { end_date: "2026-08-31", name: "Summer", start_date: "2026-7-1" },
        "start_date has an invalid value",
      ],
      [
        { end_date: "31-08-2026", name: "Summer", start_date: "2026-07-01" },
        "end_date has an invalid value",
      ],
    ];
    for (const [body, error] of refusals) {
      expect(toCreateInput(body)).toEqual({ error, ok: false });
    }
  });

  test("a create keys the cleaned values by their input names", () => {
    expect(
      toCreateInput({
        end_date: " 2026-08-31 ",
        name: " Summer Break ",
        start_date: " 2026-07-01 ",
      }),
    ).toEqual({
      ok: true,
      value: {
        endDate: "2026-08-31",
        name: "Summer Break",
        startDate: "2026-07-01",
      },
    });
  });

  test("an update keeps each stored value it does not supply", () => {
    expect(toUpdateInput({}, stored)).toEqual({
      ok: true,
      value: {
        endDate: "2026-08-31",
        name: "Summer Break",
        startDate: "2026-07-01",
      },
    });
    expect(
      toUpdateInput(
        { end_date: "2026-09-30", name: "Autumn", start_date: "2026-09-01" },
        stored,
      ),
    ).toEqual({
      ok: true,
      value: {
        endDate: "2026-09-30",
        name: "Autumn",
        startDate: "2026-09-01",
      },
    });
  });

  test("an update refuses an unusable value it supplies", () => {
    expect(toUpdateInput({ start_date: "2027-02-30" }, stored)).toEqual({
      error: "start_date has an invalid value",
      ok: false,
    });
    expect(toUpdateInput({ name: "  " }, stored)).toEqual({
      error: "name cannot be empty",
      ok: false,
    });
  });

  test("a checked form becomes the input the fields declare", () => {
    expect(
      formInput(HOLIDAY_FIELDS)({
        end_date: "2026-12-26",
        name: "Christmas",
        start_date: "2026-12-24",
      }),
    ).toEqual({
      endDate: "2026-12-26",
      name: "Christmas",
      startDate: "2026-12-24",
    });
  });
});
