import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { newRowDefaults } from "#shared/rest/field-defaults.ts";
import type { FieldSpec } from "#shared/rest/field-specs.ts";

const WEEKDAYS = ["monday", "friday"] as const;

describe("newRowDefaults", () => {
  test("gives the declared default of each kind that keeps one", () => {
    expect(
      newRowDefaults([
        { default: "email", key: "fields", kind: "contactFields" },
        { default: 4, key: "max_quantity", kind: "count" },
        { default: 2, key: "duration_days", kind: "durationDays" },
        { default: "standard", key: "listing_type", kind: "listingType" },
        { default: 500, key: "unit_price", kind: "price" },
        { default: "month", key: "interval", kind: "recurringInterval" },
      ]),
    ).toEqual({
      durationDays: 2,
      fields: "email",
      interval: "month",
      listingType: "standard",
      maxQuantity: 4,
      unitPrice: 500,
    });
  });

  test("gives an empty text to a datetime and to a private text", () => {
    expect(
      newRowDefaults([
        { key: "closes_at", kind: "datetime" },
        { key: "notes", kind: "privateText" },
      ]),
    ).toEqual({ closesAt: "", notes: "" });
  });

  test("gives a switch true only when its default is true", () => {
    expect(
      newRowDefaults([
        { default: true, key: "on", kind: "switch" },
        { default: false, key: "off", kind: "switch" },
        { key: "unset", kind: "switch" },
      ]),
    ).toEqual({ off: false, on: true, unset: false });
  });

  test("gives a copy of the weekday list, and nothing without one", () => {
    const field: FieldSpec = {
      default: WEEKDAYS,
      key: "days",
      kind: "weekdays",
    };
    const values = newRowDefaults([
      field,
      { key: "no_days", kind: "weekdays" },
    ]);

    expect(values).toEqual({ days: ["monday", "friday"] });
    expect(values.days).not.toBe(field.default);
  });

  test("leaves out each kind that a new row must give", () => {
    expect(
      newRowDefaults([
        { default: "x", key: "start_date", kind: "date" },
        { key: "day_prices", kind: "dayPrices" },
        { key: "name", kind: "name" },
        { key: "opens_at", kind: "optionalDatetime" },
        { default: "x", key: "description", kind: "text" },
      ]),
    ).toEqual({});
  });
});

describe("newRowDefaults over the record field lists", () => {
  test("gives every listing default", () => {
    expect(newRowDefaults(LISTING_FIELDS)).toEqual({
      active: true,
      assignBuiltSite: false,
      bookableAlone: false,
      bookableDays: VALID_DAY_NAMES,
      canPayMore: false,
      customisableDays: false,
      date: "",
      description: "",
      durationDays: 1,
      fields: "email",
      hidden: false,
      initialSiteMonths: 0,
      listingType: "standard",
      location: "",
      maximumDaysAfter: 90,
      maxPrice: 0,
      maxQuantity: 1,
      minimumDaysBefore: 1,
      minQuantity: 1,
      monthsPerUnit: 0,
      nonTransferable: false,
      purchaseOnly: false,
      recurringInterval: "",
      recurringPrice: 0,
      thankYouUrl: "",
      unitPrice: 0,
      useDefaults: false,
      usesLogistics: false,
      webhookUrl: "",
    });
  });

  test("gives every group default", () => {
    expect(newRowDefaults(GROUP_FIELDS)).toEqual({
      description: "",
      hidden: false,
      hidePackageListings: false,
      isPackage: false,
      maxAttendees: 0,
      scanChecksInAllListings: false,
      showHiddenListings: true,
      termsAndConditions: "",
    });
  });
});
