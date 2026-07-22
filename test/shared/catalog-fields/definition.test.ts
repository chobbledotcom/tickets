import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  isValidCatalogApiValue,
  projectCatalogFields,
} from "#shared/catalog-fields/definition.ts";
import {
  groupCatalogFields,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";

describe("catalog field projection", () => {
  test("projects stored columns under their database names", () => {
    const columns = projectCatalogFields(listingCatalogFields, "columns", {});

    expect(columns.active.default?.()).toBe(true);
    expect(columns.assign_built_site.default?.()).toBe(false);
    expect(columns.max_price.default?.()).toBe(0);
    expect(Object.hasOwn(columns, "closes_at")).toBe(false);
    expect(Object.hasOwn(columns, "name")).toBe(false);
  });

  test("projects transfer schemas by catalog field name", () => {
    const schemas = {
      boolean: v.boolean(),
      name: v.string(),
      nonNegativeInt: v.number(),
      string: v.string(),
    };

    expect(projectCatalogFields(groupCatalogFields, "schema", schemas)).toEqual(
      {
        description: schemas.string,
        hidden: schemas.boolean,
        hidePackageListings: schemas.boolean,
        isPackage: schemas.boolean,
        maxAttendees: schemas.nonNegativeInt,
        name: schemas.name,
        termsAndConditions: schemas.string,
      },
    );
  });

  test("throws when a catalog transfer schema is missing", () => {
    expect(() =>
      projectCatalogFields(groupCatalogFields, "schema", {
        boolean: v.boolean(),
        name: v.string(),
        nonNegativeInt: v.number(),
      }),
    ).toThrow("Missing catalog schema: string");
  });

  test("parses form values and keeps neutral defaults", () => {
    expect(
      projectCatalogFields(groupCatalogFields, "form", {
        description: "Description",
        hidden: "1",
        hide_package_listings: "0",
        is_package: "",
        max_attendees: null,
        name: "Package",
        terms_and_conditions: "Terms",
      }),
    ).toEqual({
      description: "Description",
      hidden: true,
      hidePackageListings: false,
      isPackage: false,
      maxAttendees: 0,
      name: "Package",
      termsAndConditions: "Terms",
    });
  });

  test("keeps zero form values and omits fields that are not on the form", () => {
    expect(
      projectCatalogFields(listingCatalogFields, "form", {
        active: false,
        maximum_days_after: 0,
        name: "Listing",
      }),
    ).toMatchObject({ maximumDaysAfter: 0, name: "Listing" });
    expect(
      Object.hasOwn(
        projectCatalogFields(listingCatalogFields, "form", { active: false }),
        "active",
      ),
    ).toBe(false);
  });

  test("projects valid API values without losing false, zero, or null clears", () => {
    expect(
      projectCatalogFields(listingCatalogFields, "api", {
        active: false,
        assign_built_site: true,
        bookable_days: ["Monday"],
        closes_at: null,
        description: "Description",
        duration_days: 0,
        max_attendees: 0,
        max_price: 0,
        purchase_only: true,
        unit_price: 0,
      }),
    ).toEqual({
      active: false,
      bookableDays: ["Monday"],
      closesAt: "",
      description: "Description",
      durationDays: 0,
      maxAttendees: 0,
      maxPrice: 0,
      unitPrice: 0,
    });
  });

  test("omits API values with the wrong type", () => {
    expect(
      projectCatalogFields(listingCatalogFields, "api", {
        active: "false",
        bookable_days: "Monday",
        description: 4,
        duration_days: "2",
        max_attendees: "10",
        max_price: "100",
        unit_price: "50",
      }),
    ).toEqual({});
  });

  test("accepts only records for object API fields", () => {
    const fields = {
      dayPrices: ["day_prices", undefined, "dayPrices", 1],
    } as const;

    expect(
      projectCatalogFields(fields, "api", { day_prices: { 1: 500 } }),
    ).toEqual({ dayPrices: { 1: 500 } });
    expect(projectCatalogFields(fields, "api", { day_prices: [500] })).toEqual(
      {},
    );
    expect(projectCatalogFields(fields, "api", { day_prices: null })).toEqual(
      {},
    );
  });

  test("only clears string API fields when their value is null", () => {
    expect(
      projectCatalogFields(groupCatalogFields, "api", {
        description: null,
        is_package: null,
        max_attendees: null,
      }),
    ).toEqual({ description: "" });
  });

  test("validates API limits from catalog field metadata", () => {
    expect(isValidCatalogApiValue(groupCatalogFields.maxAttendees, 0)).toBe(
      true,
    );
    expect(isValidCatalogApiValue(groupCatalogFields.maxAttendees, -1)).toBe(
      false,
    );
    expect(
      isValidCatalogApiValue(
        groupCatalogFields.maxAttendees,
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ).toBe(false);
    expect(isValidCatalogApiValue(groupCatalogFields.hidden, false)).toBe(true);
    expect(isValidCatalogApiValue(groupCatalogFields.hidden, "false")).toBe(
      false,
    );
  });

  test("projects every stored API value and clears null strings", () => {
    expect(
      projectCatalogFields(groupCatalogFields, "storedApi", {
        description: null,
        hidden: false,
        hide_package_listings: false,
        is_package: false,
        max_attendees: 0,
        terms_and_conditions: "",
      }),
    ).toEqual({
      description: "",
      hidden: false,
      hidePackageListings: false,
      isPackage: false,
      maxAttendees: 0,
      termsAndConditions: "",
    });
  });

  test("omits excluded and empty transfer values", () => {
    expect(
      projectCatalogFields(
        listingCatalogFields,
        "transfer",
        {
          attachment_name: "private.pdf",
          day_prices: {},
          name: "Listing",
          webhook_url: "secret",
        },
        ["webhookUrl"],
      ),
    ).toEqual({ name: "Listing" });
  });

  test("keeps non-empty day prices in transfer values", () => {
    expect(
      projectCatalogFields(listingCatalogFields, "transfer", {
        day_prices: { 1: 500 },
      }),
    ).toEqual({ dayPrices: { 1: 500 } });
  });
});
