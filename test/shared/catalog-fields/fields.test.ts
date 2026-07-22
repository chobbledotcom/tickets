import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  groupCatalogFields,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";

interface DefaultColumn {
  default?: (() => unknown) | undefined;
}

const defaultsOf = (columns: Record<string, DefaultColumn>) =>
  Object.fromEntries(
    Object.entries(columns).flatMap(([name, column]) =>
      column.default ? [[name, column.default()]] : [],
    ),
  );

describe("catalog fields", () => {
  test("declares every listing storage default", () => {
    const columns = projectCatalogFields(listingCatalogFields, "columns", {});

    expect(defaultsOf(columns)).toEqual({
      active: true,
      assign_built_site: false,
      attachment_name: "",
      attachment_url: "",
      bookable_alone: false,
      bookable_days: VALID_DAY_NAMES,
      can_pay_more: false,
      customisable_days: false,
      description: "",
      duration_days: 1,
      fields: "email",
      hidden: false,
      initial_site_months: 0,
      listing_type: "standard",
      location: "",
      max_price: 0,
      max_quantity: 1,
      maximum_days_after: 90,
      minimum_days_before: 1,
      months_per_unit: 0,
      non_transferable: false,
      purchase_only: false,
      thank_you_url: "",
      unit_price: 0,
      use_defaults: false,
      uses_logistics: false,
      webhook_url: "",
    });
  });

  test("declares every group storage default", () => {
    const columns = projectCatalogFields(groupCatalogFields, "columns", {});

    expect(defaultsOf(columns)).toEqual({
      description: "",
      hidden: false,
      hide_package_listings: false,
      is_package: false,
      terms_and_conditions: "",
    });
  });

  test("names each stored JSON field when its value is invalid", () => {
    const columns = projectCatalogFields(listingCatalogFields, "columns", {});

    expect(() => columns.bookable_days.read?.("bad json" as never)).toThrow(
      "listings.bookable_days",
    );
    expect(() => columns.day_prices.read?.("bad json" as never)).toThrow(
      "listings.day_prices",
    );
  });

  test("declares every listing API and form field", () => {
    const values = {
      active: false,
      bookable_alone: false,
      bookable_days: [],
      can_pay_more: false,
      closes_at: "",
      customisable_days: false,
      date: "",
      description: "",
      duration_days: 1,
      fields: "email",
      hidden: false,
      initial_site_months: 0,
      listing_type: "standard",
      location: "",
      max_attendees: 1,
      max_price: 0,
      max_quantity: 1,
      maximum_days_after: 0,
      minimum_days_before: 0,
      months_per_unit: 0,
      name: "Listing",
      non_transferable: false,
      purchase_only: false,
      thank_you_url: "",
      unit_price: 0,
      use_defaults: false,
      webhook_url: "",
    };

    expect(
      Object.keys(
        projectCatalogFields(listingCatalogFields, "api", values),
      ).toSorted(),
    ).toEqual([
      "active",
      "bookableAlone",
      "bookableDays",
      "canPayMore",
      "closesAt",
      "customisableDays",
      "date",
      "description",
      "durationDays",
      "fields",
      "hidden",
      "listingType",
      "location",
      "maxAttendees",
      "maxPrice",
      "maxQuantity",
      "maximumDaysAfter",
      "minimumDaysBefore",
      "nonTransferable",
      "thankYouUrl",
      "unitPrice",
      "useDefaults",
      "webhookUrl",
    ]);
    expect(
      Object.keys(
        projectCatalogFields(listingCatalogFields, "form", values),
      ).toSorted(),
    ).toEqual([
      "bookableAlone",
      "canPayMore",
      "customisableDays",
      "description",
      "durationDays",
      "fields",
      "hidden",
      "initialSiteMonths",
      "location",
      "maxAttendees",
      "maxQuantity",
      "maximumDaysAfter",
      "minimumDaysBefore",
      "monthsPerUnit",
      "name",
      "nonTransferable",
      "purchaseOnly",
      "thankYouUrl",
    ]);
  });

  test("declares every form-only default", () => {
    expect(
      projectCatalogFields(listingCatalogFields, "form", { name: "Listing" }),
    ).toMatchObject({
      durationDays: 1,
      initialSiteMonths: 0,
      maximumDaysAfter: 90,
      minimumDaysBefore: 1,
      monthsPerUnit: 0,
    });
    expect(
      projectCatalogFields(groupCatalogFields, "form", { name: "Group" }),
    ).toMatchObject({ maxAttendees: 0, name: "Group" });
  });

  test("declares the transfer schema used by every listing field", () => {
    const names = {
      bookableDays: "bookableDays",
      boolean: "boolean",
      datetime: "datetime",
      dayPrices: "dayPrices",
      durationDays: "durationDays",
      fields: "fields",
      listingType: "listingType",
      maxPrice: "maxPrice",
      name: "name",
      nonNegativeInt: "nonNegativeInt",
      nullableDatetime: "nullableDatetime",
      positiveInt: "positiveInt",
      price: "price",
      requiredPositiveInt: "requiredPositiveInt",
      string: "string",
    } as const;

    expect(projectCatalogFields(listingCatalogFields, "schema", names)).toEqual(
      {
        active: names.boolean,
        assignBuiltSite: names.boolean,
        bookableAlone: names.boolean,
        bookableDays: names.bookableDays,
        canPayMore: names.boolean,
        closesAt: names.nullableDatetime,
        customisableDays: names.boolean,
        date: names.datetime,
        dayPrices: names.dayPrices,
        description: names.string,
        durationDays: names.durationDays,
        fields: names.fields,
        hidden: names.boolean,
        initialSiteMonths: names.nonNegativeInt,
        listingType: names.listingType,
        location: names.string,
        maxAttendees: names.requiredPositiveInt,
        maximumDaysAfter: names.nonNegativeInt,
        maxPrice: names.maxPrice,
        maxQuantity: names.positiveInt,
        minimumDaysBefore: names.nonNegativeInt,
        monthsPerUnit: names.nonNegativeInt,
        name: names.name,
        nonTransferable: names.boolean,
        purchaseOnly: names.boolean,
        thankYouUrl: names.string,
        unitPrice: names.price,
        useDefaults: names.boolean,
        usesLogistics: names.boolean,
        webhookUrl: names.string,
      },
    );
    expect(projectCatalogFields(groupCatalogFields, "schema", names)).toEqual({
      description: names.string,
      hidden: names.boolean,
      hidePackageListings: names.boolean,
      isPackage: names.boolean,
      maxAttendees: names.nonNegativeInt,
      name: names.name,
      termsAndConditions: names.string,
    });
  });
});
