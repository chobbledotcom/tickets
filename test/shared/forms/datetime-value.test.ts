// test-groups: run-alone
/** The datetime composition at the form boundary. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { getDatetimeValue } from "#shared/forms/datetime-value.ts";

describe("getDatetimeValue", () => {
  test("composes both parts with the date half cleaned", () => {
    const form = new FormParams([
      ["closesAtDate", " 2027-06-01 "],
      ["closesAtTime", "18:30"],
    ]);
    expect(getDatetimeValue(form, "closesAt")).toBe("2027-06-01T18:30");
  });

  test("defaults a missing time to midnight", () => {
    const form = new FormParams([["closesAtDate", "2027-06-01"]]);
    expect(getDatetimeValue(form, "closesAt")).toBe("2027-06-01T00:00");
  });

  test("answers blank when both parts are blank", () => {
    const form = new FormParams([
      ["closesAtDate", ""],
      ["closesAtTime", ""],
    ]);
    expect(getDatetimeValue(form, "closesAt")).toBe("");
  });

  test("answers null for a time without a date", () => {
    const form = new FormParams([["closesAtTime", "18:30"]]);
    expect(getDatetimeValue(form, "closesAt")).toBeNull();
  });

  test("composes an unusable date half raw for the field hook", () => {
    const form = new FormParams([
      ["closesAtDate", "2027-02-30"],
      ["closesAtTime", "18:30"],
    ]);
    expect(getDatetimeValue(form, "closesAt")).toBe("2027-02-30T18:30");
  });
});
