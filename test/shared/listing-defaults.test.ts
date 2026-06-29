import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  hasAnyListingDefault,
  LISTING_DEFAULT_FIELDS,
  type ListingDefaults,
  listingDefaultFieldClass,
  listingDefaultFormClasses,
  listingDefaultHintKey,
  listingDefaultInputName,
  listingDefaultLabelKey,
  parseListingDefaults,
  resolveListingDefaults,
  serializeListingDefaults,
  setListingDefaultFields,
} from "#shared/listing-defaults.ts";
import { testListing } from "#test-utils";

const fullDefaults: ListingDefaults = {
  bookableDays: ["Monday", "Wednesday"],
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
    expect(resolveListingDefaults(listing, fullDefaults, true)).toBe(listing);
  });

  test("overlays every set default when use_defaults is on", () => {
    const listing = testListing({
      bookable_days: ["Sunday"],
      hidden: false,
      maximum_days_after: 90,
      minimum_days_before: 1,
      thank_you_url: "",
      use_defaults: true,
      uses_logistics: false,
      webhook_url: "",
    });
    const resolved = resolveListingDefaults(listing, fullDefaults, true);
    expect(resolved.bookable_days).toEqual(["Monday", "Wednesday"]);
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
    const resolved = resolveListingDefaults(
      listing,
      { webhookUrl: "https://example.com/only" },
      true,
    );
    expect(resolved.webhook_url).toBe("https://example.com/only");
    expect(resolved.hidden).toBe(false);
    expect(resolved.uses_logistics).toBe(true);
  });

  test("does not apply the logistics default while logistics is off", () => {
    const listing = testListing({ use_defaults: true, uses_logistics: false });
    // hasLogistics off → the stored uses_logistics=true default stays inert.
    expect(
      resolveListingDefaults(listing, { usesLogistics: true }, false)
        .uses_logistics,
    ).toBe(false);
    // hasLogistics on → the default applies.
    expect(
      resolveListingDefaults(listing, { usesLogistics: true }, true)
        .uses_logistics,
    ).toBe(true);
  });

  test("never makes a renewal tier visible via a hidden default", () => {
    const tier = testListing({
      hidden: true,
      months_per_unit: 12,
      purchase_only: true,
      use_defaults: true,
    });
    // A "Hidden = No" default must not flip a renewal tier visible.
    expect(resolveListingDefaults(tier, { hidden: false }, true).hidden).toBe(
      true,
    );
    // A non-renewal listing still inherits the hidden default.
    const normal = testListing({ hidden: true, use_defaults: true });
    expect(resolveListingDefaults(normal, { hidden: false }, true).hidden).toBe(
      false,
    );
  });

  test("does not mutate the original listing", () => {
    const listing = testListing({ hidden: false, use_defaults: true });
    resolveListingDefaults(listing, { hidden: true }, true);
    expect(listing.hidden).toBe(false);
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

describe("shared > listing-defaults > setListingDefaultFields", () => {
  test("returns only the set fields, in display order", () => {
    const fields = setListingDefaultFields({
      hidden: true,
      usesLogistics: true,
    });
    // Display order is uses_logistics before hidden, regardless of insertion.
    expect(fields.map((f) => f.field)).toEqual(["uses_logistics", "hidden"]);
  });

  test("is empty when nothing is set", () => {
    expect(setListingDefaultFields({})).toEqual([]);
  });
});

describe("shared > listing-defaults > i18n + input-name builders", () => {
  const usesLogistics = LISTING_DEFAULT_FIELDS.find(
    (f) => f.field === "uses_logistics",
  ) as (typeof LISTING_DEFAULT_FIELDS)[number];

  test("builds the form input name from the column", () => {
    expect(listingDefaultInputName(usesLogistics)).toBe(
      "default_uses_logistics",
    );
  });

  test("builds the label key from the column", () => {
    expect(listingDefaultLabelKey(usesLogistics)).toBe(
      "listing_defaults.field.uses_logistics.label",
    );
  });

  test("builds the hint key from the column", () => {
    expect(listingDefaultHintKey(usesLogistics)).toBe(
      "listing_defaults.field.uses_logistics.hint",
    );
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
      hidden: "yes",
      minimumDaysBefore: "3",
      usesLogistics: 1,
      webhookUrl: 5,
    });
    expect(parseListingDefaults(raw)).toEqual({});
  });

  test("drops a non-finite number", () => {
    // JSON has no NaN; a stored null for a number key must be rejected.
    expect(parseListingDefaults('{"minimumDaysBefore":null}')).toEqual({});
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
