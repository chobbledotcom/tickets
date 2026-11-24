/** The value that each field kind reads from a checked form box and from a JSON
 *  body, read through the field list. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { formFieldsInput, readBody } from "#shared/rest/field-reads.ts";
import type { FieldSpec } from "#shared/rest/field-specs.ts";

/** No field is closed to this writer. */
const NONE = new Map();

describe("form field reads", () => {
  test("a form reads each shown switch box and the count its page sent", () => {
    expect(
      formFieldsInput(
        GROUP_FIELDS,
        {
          description: "Description",
          hidden: "1",
          hidePackageListings: "0",
          isPackage: "",
          maxAttendees: 0,
          name: "Package",
          scanChecksInAllListings: "1",
          showHiddenListings: "1",
          termsAndConditions: "Terms",
        },
        new Set(GROUP_FIELDS.map((field) => field.key)),
      ),
    ).toEqual({
      description: "Description",
      hidden: true,
      hidePackageListings: false,
      isPackage: false,
      maxAttendees: 0,
      name: "Package",
      scanChecksInAllListings: true,
      showHiddenListings: true,
      termsAndConditions: "Terms",
    });
  });

  test("a shown count box that sends no count throws", () => {
    expect(() =>
      formFieldsInput(
        GROUP_FIELDS,
        { maxAttendees: null, name: "Package" },
        new Set(["maxAttendees", "name"]),
      ),
    ).toThrow("The maxAttendees form box holds no count");
  });

  test("a form keeps a zero and reads only the fields its page shows", () => {
    const input = formFieldsInput(
      LISTING_FIELDS,
      {
        active: "1",
        maximumDaysAfter: 0,
        minimumDaysBefore: 1,
        name: "Listing",
      },
      new Set(["maximumDaysAfter", "minimumDaysBefore", "name"]),
    );
    expect(input).toEqual({
      maximumDaysAfter: 0,
      minimumDaysBefore: 1,
      name: "Listing",
    });
  });

  test("a form reads a price in major units, a local time as UTC, and a weekday list", () => {
    const input = formFieldsInput(
      LISTING_FIELDS,
      {
        bookableDays: "Monday,Friday",
        closesAt: "",
        date: "2026-01-10T10:00",
        unitPrice: "12.50",
      },
      new Set(["bookableDays", "closesAt", "date", "unitPrice"]),
    );
    expect(input).toEqual({
      bookableDays: ["Monday", "Friday"],
      closesAt: null,
      date: "2026-01-10T10:00:00.000Z",
      unitPrice: 1250,
    });
  });

  test("a blank form price box takes the default that its field declares", () => {
    expect(
      formFieldsInput(
        LISTING_FIELDS,
        { recurringPrice: "", unitPrice: "12.50" },
        new Set(["recurringPrice", "unitPrice"]),
      ),
    ).toEqual({ recurringPrice: 0, unitPrice: 1250 });
  });

  test("a form price box that holds no price and has no default throws", () => {
    const noDefault = LISTING_FIELDS.map((field) =>
      field.key === "unitPrice" ? { key: field.key, kind: field.kind } : field,
    );
    for (const value of ["", "abc"]) {
      expect(() =>
        formFieldsInput(
          value === "" ? noDefault : LISTING_FIELDS,
          { unitPrice: value },
          new Set(["unitPrice"]),
        ),
      ).toThrow("The unitPrice form box holds no price");
    }
  });
});

/** The input that one checked form box of one field gives. */
const formRead = (field: FieldSpec, value: unknown) =>
  formFieldsInput([field], { [field.key]: value }, new Set([field.key]));

describe("the reads of each field kind", () => {
  /* jscpd:ignore-start -- a list of rows, not code */
  const FORM_ROWS: [FieldSpec, unknown, unknown][] = [
    [{ key: "at", kind: "datetime" }, "", ""],
    [
      { key: "at", kind: "datetime" },
      "2025-01-02T10:00",
      "2025-01-02T10:00:00.000Z",
    ],
    [{ key: "at", kind: "optionalDatetime" }, "", null],
    [
      { key: "at", kind: "optionalDatetime" },
      "2025-01-02T10:00",
      "2025-01-02T10:00:00.000Z",
    ],
    [{ key: "cost", kind: "price" }, "12.50", 1250],
    [{ key: "cost", kind: "price" }, "0", 0],
    [{ default: 500, key: "cost", kind: "price" }, "", 500],
    [{ key: "on", kind: "switch" }, "1", true],
    [{ key: "on", kind: "switch" }, "", false],
    [{ default: "d", key: "note", kind: "text" }, "", ""],
    [{ default: "d", key: "note", kind: "text" }, undefined, "d"],
  ];
  /* jscpd:ignore-end */

  test("a checked form box stores the value of its kind, and a missing one takes the declared default", () => {
    expect(FORM_ROWS.map(([field, value]) => formRead(field, value))).toEqual(
      FORM_ROWS.map(([field, , stored]) => ({ [field.key]: stored })),
    );
  });

  test("a price box with no price and no default stops the read", () => {
    for (const value of ["", "abc"]) {
      expect(() => formRead({ key: "cost", kind: "price" }, value)).toThrow(
        "The cost form box holds no price",
      );
    }
  });

  test("a create reads a recurring interval it leaves out, or sends as null, as empty", () => {
    const interval: FieldSpec = { key: "every", kind: "recurringInterval" };

    expect(
      [{}, { every: null }].map((body) =>
        readBody([interval], body, null, NONE),
      ),
    ).toEqual([
      { ok: true, value: { every: "" } },
      { ok: true, value: { every: "" } },
    ]);
  });

  test("a Markdown field refuses a value that is not text, and keeps the indent of one that is", () => {
    const notes: FieldSpec = { key: "notes", kind: "text", markdown: true };

    expect(
      [5, "\n\n    code  \n"].map((value) =>
        readBody([notes], { notes: value }, null, NONE),
      ),
    ).toEqual([
      { error: "notes has an invalid value", ok: false },
      { ok: true, value: { notes: "    code" } },
    ]);
  });

  test("a create accepts a required field that is supplied as 0 or false", () => {
    const required = [
      { key: "seats", kind: "count", required: true },
      { key: "open", kind: "switch", required: true },
    ] as const;

    expect(readBody(required, { open: false, seats: 0 }, null, NONE)).toEqual({
      ok: true,
      value: { open: false, seats: 0 },
    });
  });
});
