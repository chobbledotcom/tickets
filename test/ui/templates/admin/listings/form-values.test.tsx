/** Direct tests for the listing form's value builders: the rows of day-price
 * boxes, a stored listing's field values, the defaults page's values, and the
 * templated form's class markers. */

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
  showUseDefaultsToggle,
} from "#templates/admin/listings/form-values.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("renderDayPricesFieldset", () => {
  test("offers one row per day of the listing's longest stay", () => {
    const html = renderDayPricesFieldset(
      testListingWithCount({ duration_days: 2 }),
    );
    expect(html).toContain('name="day_price_1"');
    expect(html).toContain('name="day_price_2"');
    expect(html).not.toContain('name="day_price_3"');
  });

  test("draws a stored override and leaves an unset day to its placeholder", () => {
    const html = renderDayPricesFieldset(
      testListingWithCount({ day_prices: { 1: 1500 }, duration_days: 2 }),
    );
    expect(html).toMatch(/name="day_price_1"[^>]*value="15\.00"/);
    // Day 2 has no stored override, so its own price stands in as the
    // placeholder and its value stays empty.
    expect(html).toMatch(/name="day_price_2"[^>]*value=""/);
  });

  test("wraps its rows in one fieldset and labels them tight together", () => {
    const html = renderDayPricesFieldset(
      testListingWithCount({ duration_days: 2 }),
    );
    expect(html).toContain("</fieldset>");
    // Every day's row is one label with its box inside it, labeled by the
    // day it prices and closed before the next day's row starts.
    expect(html).toContain("</label><label>");
    expect(html).toContain(
      `${t("listings_table.day_price_row_label", { n: 1 })}<input`,
    );
  });

  test("a fresh form offers a single day", () => {
    const html = renderDayPricesFieldset();
    expect(html).toContain('name="day_price_1"');
    expect(html).not.toContain('name="day_price_2"');
  });
});

describe("listingToFieldValues", () => {
  test("carries the slug and the price as typed money", () => {
    const values = listingToFieldValues(
      testListingWithCount({
        non_transferable: true,
        slug: "summer-entry",
        unit_price: 1500,
      }),
    );
    expect(values.slug).toBe("summer-entry");
    expect(values.unit_price).toBe("15.00");
    expect(values.non_transferable).toBe("1");
    expect(values.hidden).toBe("");
  });

  test("a free listing leaves its price box empty rather than typing 0.00", () => {
    const values = listingToFieldValues(
      testListingWithCount({ unit_price: 0 }),
    );
    expect(values.unit_price).toBe("");
  });

  test("a one-penny price still fills the box", () => {
    const values = listingToFieldValues(
      testListingWithCount({ unit_price: 1 }),
    );
    expect(values.unit_price).toBe("0.01");
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
        initial_site_months: 6,
        months_per_unit: 3,
      }),
    );
    expect(kept.initial_site_months).toBe("6");
    expect(kept.months_per_unit).toBe("3");

    const planless = listingToFieldValues(
      testListingWithCount({
        initial_site_months: 0,
        months_per_unit: 0,
      }),
    );
    expect(planless.initial_site_months).toBe("");
    expect(planless.months_per_unit).toBe("");
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
      bookable_days: "Monday, Tuesday",
      hidden: "1",
      minimum_days_before: "2",
      thank_you_url: "",
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
        "listing-form--templated listing-form--hide-type listing-form--hide-date listing-form--default-hidden",
    });
    expect(listingFormClassAttr(null, withDefault)).toEqual({
      class: "listing-form--default-hidden",
    });
    expect(listingFormClassAttr(null, {})).toEqual({});
  });
});

describe("showUseDefaultsToggle", () => {
  test("only an owner sees the toggle, and only once a default exists", () => {
    const defaults: ListingDefaults = { hidden: true };
    expect(showUseDefaultsToggle(OWNER_SESSION, defaults)).toBe(true);
    expect(showUseDefaultsToggle(OWNER_SESSION, {})).toBe(false);
    const editor = { ...OWNER_SESSION, adminLevel: "editor" } as const;
    expect(showUseDefaultsToggle(editor, defaults)).toBe(false);
  });
});
