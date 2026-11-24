/** Direct tests for the listing form's value builders: the rows of day-price
 * boxes, a stored listing's field values, the defaults page's values, and the
 * templated form's class markers. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { ListingDefaults } from "#shared/listing-defaults.ts";
import {
  defaultsToFieldValues,
  listingFormClass,
  listingFormClassAttr,
  listingToFieldValues,
  renderDayPricesFieldset,
} from "#templates/admin/listings/form-values.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("renderDayPricesFieldset", () => {
  test("offers one row per day of the listing's longest stay", () => {
    const html = renderDayPricesFieldset(
      testListingWithCount({ durationDays: 2 }),
    );
    expectIncludesAll(html, ['name="dayPrice1"', 'name="dayPrice2"']);
    assert(!html.includes('name="dayPrice3"'));
  });

  test("draws a stored override and leaves an unset day to its placeholder", () => {
    const html = renderDayPricesFieldset(
      testListingWithCount({ dayPrices: { 1: 1500 }, durationDays: 2 }),
    );
    expect(html).toMatch(/name="dayPrice1"[^>]*value="15\.00"/);
    // Day 2 has no stored override, so its own price stands in as the
    // placeholder and its value stays empty.
    expect(html).toMatch(/name="dayPrice2"[^>]*value=""/);
  });

  test("wraps its rows in one fieldset and labels them tight together", () => {
    const html = renderDayPricesFieldset(
      testListingWithCount({ durationDays: 2 }),
    );
    expectIncludesAll(html, [
      "</fieldset>",
      // Every day's row is one label with its box inside it, labeled by the
      // day it prices and closed before the next day's row starts.
      "</label><label>",
      `${t("listings_table.day_price_row_label", { n: 1 })}<input`,
    ]);
  });

  test("a fresh form offers a single day", () => {
    const html = renderDayPricesFieldset();
    assertStringIncludes(html, 'name="dayPrice1"');
    assert(!html.includes('name="dayPrice2"'));
  });
});

describe("listingToFieldValues", () => {
  test("carries the slug and the price as typed money", () => {
    const values = listingToFieldValues(
      testListingWithCount({
        nonTransferable: true,
        slug: "summer-entry",
        unitPrice: 1500,
      }),
    );
    expect(values.slug).toBe("summer-entry");
    expect(values.unitPrice).toBe("15.00");
    expect(values.nonTransferable).toBe("1");
    expect(values.hidden).toBe("");
  });

  test("a money box types its price, and a free recurring price stays empty", () => {
    expect(
      [0, 1, 500].map(
        (unitPrice) =>
          listingToFieldValues(testListingWithCount({ unitPrice })).unitPrice,
      ),
    ).toEqual(["0.00", "0.01", "5.00"]);
    expect(
      [0, 1, 500].map(
        (recurringPrice) =>
          listingToFieldValues(testListingWithCount({ recurringPrice }))
            .recurringPrice,
      ),
    ).toEqual(["", "0.01", "5.00"]);
  });

  test("carries a dated listing's own day in the datetime box's shape", () => {
    const values = listingToFieldValues(
      testListingWithCount({ date: "2026-01-01" }),
    );
    // The formatter draws the stored date as a local datetime input value,
    // never as a blank. The zone is the site's own, so only the shape is
    // pinned here.
    expect(values.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  test("carries site months only while the listing holds a plan", () => {
    const kept = listingToFieldValues(
      testListingWithCount({
        initialSiteMonths: 6,
        monthsPerUnit: 3,
      }),
    );
    expect(kept.initialSiteMonths).toBe("6");
    expect(kept.monthsPerUnit).toBe("3");

    const planless = listingToFieldValues(
      testListingWithCount({
        initialSiteMonths: 0,
        monthsPerUnit: 0,
      }),
    );
    expect(planless.initialSiteMonths).toBe("");
    expect(planless.monthsPerUnit).toBe("");
  });
});

describe("defaultsToFieldValues", () => {
  test("draws each set default as its own field's kind", () => {
    const defaults: ListingDefaults = {
      bookableDays: ["Monday", "Tuesday"],
      hidden: true,
      minimumDaysBefore: 2,
      thankYouUrl: "",
    };
    expect(defaultsToFieldValues(defaults)).toEqual({
      bookableDays: "Monday, Tuesday",
      hidden: "1",
      minimumDaysBefore: "2",
      thankYouUrl: "",
    });
  });
});

describe("listingFormClass", () => {
  test("marks the form by what its template locks in", () => {
    const templated = {
      signature: { daily: true, dated: false },
    } as Parameters<typeof listingFormClass>[0];
    expect(listingFormClass(templated)).toBe(
      "listing-form--templated listing-form--hide-type listing-form--hide-date",
    );

    const nonDaily = {
      signature: { daily: false },
    } as Parameters<typeof listingFormClass>[0];
    expect(listingFormClass(nonDaily)).toBe(
      "listing-form--templated listing-form--hide-type listing-form--no-daily",
    );

    const noLocation = {
      location: false,
      signature: { daily: false },
    } as Parameters<typeof listingFormClass>[0];
    expect(listingFormClass(noLocation)).toBe(
      "listing-form--templated listing-form--hide-type listing-form--no-daily listing-form--no-location",
    );

    expect(
      listingFormClass({ signature: {} } as Parameters<
        typeof listingFormClass
      >[0]),
    ).toBe("listing-form--templated");
  });
});

describe("listingFormClassAttr", () => {
  test("joins the template's markers with the set defaults' own", () => {
    const templated = {
      signature: { daily: true, dated: false },
    } as Parameters<typeof listingFormClass>[0];
    const withDefault = { hidden: true };
    expect(listingFormClassAttr(templated, withDefault)).toEqual({
      class:
        "listing-form listing-form--templated listing-form--hide-type listing-form--hide-date listing-form--default-hidden",
    });
    expect(listingFormClassAttr(null, withDefault)).toEqual({
      class: "listing-form listing-form--default-hidden",
    });
    expect(listingFormClassAttr(null, {})).toEqual({ class: "listing-form" });
  });
});
