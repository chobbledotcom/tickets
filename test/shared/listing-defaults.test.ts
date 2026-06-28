import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  hasAnyListingDefault,
  LISTING_DEFAULT_FIELDS,
  type ListingDefaults,
  listingDefaultFieldClass,
  listingDefaultFormClasses,
  parseListingDefaults,
  resolveListingDefaults,
  serializeListingDefaults,
} from "#shared/listing-defaults.ts";
import { testListing } from "#test-utils";

const fullDefaults: ListingDefaults = {
  bookableDays: ["Monday", "Wednesday"],
  customisableDays: true,
  durationDays: 3,
  hidden: true,
  maximumDaysAfter: 30,
  minimumDaysBefore: 2,
  thankYouUrl: "https://example.com/thanks",
  usesLogistics: true,
  webhookUrl: "https://example.com/hook",
};

describe("shared > listing-defaults > resolveListingDefaults", () => {
  test("returns the listing unchanged when use_defaults is off", () => {
    const listing = testListing({ hidden: false, use_defaults: false });
    expect(resolveListingDefaults(listing, fullDefaults)).toBe(listing);
  });

  test("overlays every set default when use_defaults is on", () => {
    const listing = testListing({
      bookable_days: ["Sunday"],
      customisable_days: false,
      // Day prices present so the customisable-days default is allowed to apply.
      day_prices: { 1: 1000 },
      duration_days: 1,
      hidden: false,
      maximum_days_after: 90,
      minimum_days_before: 1,
      thank_you_url: "",
      use_defaults: true,
      uses_logistics: false,
      webhook_url: "",
    });
    const resolved = resolveListingDefaults(listing, fullDefaults);
    expect(resolved.bookable_days).toEqual(["Monday", "Wednesday"]);
    expect(resolved.customisable_days).toBe(true);
    expect(resolved.duration_days).toBe(3);
    expect(resolved.hidden).toBe(true);
    expect(resolved.maximum_days_after).toBe(30);
    expect(resolved.minimum_days_before).toBe(2);
    expect(resolved.thank_you_url).toBe("https://example.com/thanks");
    expect(resolved.uses_logistics).toBe(true);
    expect(resolved.webhook_url).toBe("https://example.com/hook");
  });

  test("leaves fields without a default untouched", () => {
    const listing = testListing({
      hidden: false,
      use_defaults: true,
      uses_logistics: true,
    });
    // Only a webhook default is set — every other field keeps its own value.
    const resolved = resolveListingDefaults(listing, {
      webhookUrl: "https://example.com/only",
    });
    expect(resolved.webhook_url).toBe("https://example.com/only");
    expect(resolved.hidden).toBe(false);
    expect(resolved.uses_logistics).toBe(true);
  });

  test("does not mutate the original listing", () => {
    const listing = testListing({ hidden: false, use_defaults: true });
    resolveListingDefaults(listing, { hidden: true });
    expect(listing.hidden).toBe(false);
  });

  test("a customisable-days 'yes' default only applies where day prices exist", () => {
    const noPrices = testListing({
      customisable_days: false,
      day_prices: {},
      use_defaults: true,
    });
    expect(
      resolveListingDefaults(noPrices, { customisableDays: true })
        .customisable_days,
    ).toBe(false);

    const withPrices = testListing({
      customisable_days: false,
      day_prices: { 1: 1000 },
      use_defaults: true,
    });
    expect(
      resolveListingDefaults(withPrices, { customisableDays: true })
        .customisable_days,
    ).toBe(true);
  });

  test("a customisable-days default respects the effective (defaulted) duration", () => {
    const listing = testListing({
      customisable_days: false,
      day_prices: { 5: 1000 },
      duration_days: 5,
      use_defaults: true,
    });
    // A duration default of 3 makes the only priced count (5) invalid → skip.
    expect(
      resolveListingDefaults(listing, {
        customisableDays: true,
        durationDays: 3,
      }).customisable_days,
    ).toBe(false);
    // Without lowering the duration, count 5 is within range → applies.
    expect(
      resolveListingDefaults(listing, { customisableDays: true })
        .customisable_days,
    ).toBe(true);
  });

  test("a customisable-days 'no' default always applies", () => {
    const listing = testListing({
      customisable_days: true,
      day_prices: {},
      use_defaults: true,
    });
    expect(
      resolveListingDefaults(listing, { customisableDays: false })
        .customisable_days,
    ).toBe(false);
  });
});

describe("shared > listing-defaults > hasAnyListingDefault", () => {
  test("false for an empty defaults object", () => {
    expect(hasAnyListingDefault({})).toBe(false);
  });

  test("true when at least one default is set", () => {
    expect(hasAnyListingDefault({ hidden: false })).toBe(true);
  });
});

describe("shared > listing-defaults > CSS marker classes", () => {
  test("kebab-cases the field name", () => {
    expect(listingDefaultFieldClass("uses_logistics")).toBe(
      "listing-form--default-uses-logistics",
    );
  });

  test("emits one class per set default", () => {
    expect(
      listingDefaultFormClasses({ hidden: true, usesLogistics: true }),
    ).toBe("listing-form--default-uses-logistics listing-form--default-hidden");
  });

  test("is empty when nothing is set", () => {
    expect(listingDefaultFormClasses({})).toBe("");
  });
});

describe("shared > listing-defaults > parse/serialize round-trip", () => {
  test("round-trips a full defaults object", () => {
    const json = serializeListingDefaults(fullDefaults);
    expect(parseListingDefaults(json)).toEqual(fullDefaults);
  });

  test("serialize omits unset keys", () => {
    expect(serializeListingDefaults({ hidden: true })).toBe('{"hidden":true}');
  });

  for (const raw of [undefined, "", "not json", "[]", "42", "null"]) {
    test(`blank or non-object input parses to empty defaults: ${raw}`, () => {
      expect(parseListingDefaults(raw)).toEqual({});
    });
  }

  test("drops keys whose stored type is wrong", () => {
    const raw = JSON.stringify({
      bookableDays: "Monday",
      durationDays: "3",
      hidden: "yes",
      usesLogistics: 1,
      webhookUrl: 5,
    });
    expect(parseListingDefaults(raw)).toEqual({});
  });

  test("drops a non-finite number", () => {
    // JSON has no NaN; a stored null for a number key must be rejected.
    expect(parseListingDefaults('{"durationDays":null}')).toEqual({});
  });

  test("keeps a string array but drops one with non-string items", () => {
    expect(parseListingDefaults('{"bookableDays":["Monday",2]}')).toEqual({});
    expect(parseListingDefaults('{"bookableDays":["Monday"]}')).toEqual({
      bookableDays: ["Monday"],
    });
  });

  test("ignores unknown keys", () => {
    expect(parseListingDefaults('{"unknown":true,"hidden":true}')).toEqual({
      hidden: true,
    });
  });
});

describe("shared > listing-defaults > LISTING_DEFAULT_FIELDS", () => {
  test("every field maps a unique key and column", () => {
    const keys = LISTING_DEFAULT_FIELDS.map((f) => f.key);
    const fields = LISTING_DEFAULT_FIELDS.map((f) => f.field);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(fields).size).toBe(fields.length);
  });
});
