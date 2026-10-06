/** The one place a date-typed field's raw submitted value becomes a value:
 *  every surface gets the cleaned date without opting in. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { readSubmittedFieldValue } from "#shared/forms/submitted-value.ts";

const dateField = {
  label: "Starts",
  name: "start_date",
  required: true,
  type: "date",
} as const;

const datetimeField = {
  label: "Closes",
  name: "closes_at",
  required: true,
  type: "datetime",
} as const;

describe("readSubmittedFieldValue date cleanup", () => {
  test("a date field returns the trimmed real date", () => {
    const form = new FormParams([["start_date", "  2027-06-01  "]]);
    expect(readSubmittedFieldValue(form, dateField)).toBe("2027-06-01");
  });

  test("a date field returns null for the four refused shapes", () => {
    for (const raw of ["2027-6-1", "2027-02-30", "2027-06-01T00:00", "soon"]) {
      const form = new FormParams([["start_date", raw]]);
      expect(readSubmittedFieldValue(form, dateField)).toBeNull();
    }
  });

  test("a blank date field stays blank", () => {
    const form = new FormParams([["start_date", "   "]]);
    expect(readSubmittedFieldValue(form, dateField)).toBe("");
  });

  test("a datetime field cleans its date half before composing the value", () => {
    const form = new FormParams([
      ["closes_at_date", " 2027-06-01 "],
      ["closes_at_time", "18:30"],
    ]);
    expect(readSubmittedFieldValue(form, datetimeField)).toBe(
      "2027-06-01T18:30",
    );
  });

  test("a datetime field with an unusable date half answers null", () => {
    const form = new FormParams([
      ["closes_at_date", "2027-02-30"],
      ["closes_at_time", "18:30"],
    ]);
    expect(readSubmittedFieldValue(form, datetimeField)).toBeNull();
  });
});
