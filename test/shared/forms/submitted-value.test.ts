/** The one place a date-typed field's raw submitted value becomes a value:
 *  every surface gets the cleaned date without opting in. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  DATETIME_PARTIAL_ERROR,
  readSubmittedFieldValue,
} from "#shared/forms/submitted-value.ts";

const dateField = {
  label: "Starts",
  name: "start_date",
  required: true,
  type: "date",
} as const;

/** The value a form that submits `raw` as the start date reads as. */
const readStartDate = (raw: string) =>
  readSubmittedFieldValue(new FormParams([["start_date", raw]]), dateField);

const datetimeField = {
  label: "Closes",
  name: "closes_at",
  required: true,
  type: "datetime",
} as const;

describe("readSubmittedFieldValue date cleanup", () => {
  test("a date field returns the trimmed real date", () => {
    expect(readStartDate("  2027-06-01  ")).toBe("2027-06-01");
  });

  test("a date field passes an unusable value through for the field message", () => {
    // The field's own validate hook reports the old copy; the boundary only
    // guarantees that a usable value is cleaned.
    const unusable = [
      "2027-6-1",
      "2027-02-30",
      "2027-06-01T00:00",
      "soon",
      "mutated",
    ];
    for (const raw of unusable) {
      expect(readStartDate(raw)).toBe(raw);
    }
  });

  test("a time without a date reads as the partial the message names", () => {
    const form = new FormParams([["closes_at_time", "18:30"]]);
    expect(readSubmittedFieldValue(form, datetimeField)).toBe(null);
    expect(DATETIME_PARTIAL_ERROR).toBe(
      "Please enter a date when providing a time, or leave both blank",
    );
  });

  test("a blank date field stays blank", () => {
    expect(readStartDate("   ")).toBe("");
  });

  // Each row: the test name, the submitted date half at 18:30, the value read.
  const COMPOSED = [
    [
      "a datetime field cleans its date half before composing the value",
      " 2027-06-01 ",
      "2027-06-01T18:30",
    ],
    [
      "a datetime field composes an unusable date half raw",
      "2027-02-30",
      "2027-02-30T18:30",
    ],
  ] as const;

  for (const [name, date, value] of COMPOSED) {
    test(name, () => {
      const form = new FormParams([
        ["closes_at_date", date],
        ["closes_at_time", "18:30"],
      ]);
      expect(readSubmittedFieldValue(form, datetimeField)).toBe(value);
    });
  }
});

describe("readSubmittedFieldValue Markdown text", () => {
  const markdownField = {
    label: "Content",
    markdown: true,
    name: "content",
    type: "textarea",
  } as const;
  const plainField = {
    label: "Notes",
    name: "content",
    type: "textarea",
  } as const;

  // Each row: the test name, the box, the submitted text, the value read.
  const READS = [
    [
      "a Markdown box keeps the indentation of its first line",
      markdownField,
      "\r\n \n    code\n  more  \n\n",
      "    code\n  more",
    ],
    ["a Markdown box with only spaces is blank", markdownField, "  \n \t ", ""],
    ["a plain text box is trimmed", plainField, "    code\n", "code"],
  ] as const;

  for (const [name, field, raw, value] of READS) {
    test(name, () => {
      const form = new FormParams([["content", raw]]);
      expect(readSubmittedFieldValue(form, field)).toBe(value);
    });
  }

  test("a Markdown box that the form omits is blank", () => {
    expect(readSubmittedFieldValue(new FormParams(), markdownField)).toBe("");
  });
});
