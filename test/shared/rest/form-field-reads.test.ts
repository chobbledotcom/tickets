/** The value a checked form box stores, read through the field list. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { formFieldsInput } from "#shared/rest/field-reads.ts";

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
