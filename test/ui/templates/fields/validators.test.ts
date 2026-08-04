import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  buildDescriptionField,
  buildHiddenField,
  getSlugField,
  getUsernameFieldBase,
  slugFieldBase,
  validateAddress,
  validateBookableDays,
  validateDate,
  validateDatetime,
  validateDescription,
  validateEmail,
  validateHttpsDomainUrl,
  validateListingFields,
  validateNonNegativeInteger,
  validateNonNegativePrice,
  validatePhone,
  validateSpecialInstructions,
  validateUpdateTier,
  validateUsername,
} from "#templates/fields/validators.ts";

/** A validator accepts a value when it returns exactly `null` (not `undefined`,
 *  which a `return null -> return undefined` mutant would produce). */
const accepts = (validate: (v: string) => string | null, value: string) =>
  expect(validate(value)).toBeNull();

/** A validator rejects a value when it returns a non-empty error message. */
const rejects = (validate: (v: string) => string | null, value: string) => {
  const result = validate(value);
  expect(typeof result).toBe("string");
  expect(result).not.toBe("");
};

describe("fields validators", () => {
  describe("numeric and URL validators", () => {
    test("accepts public HTTPS URLs only", () => {
      accepts(validateHttpsDomainUrl, "https://example.com/path");
      rejects(validateHttpsDomainUrl, "http://example.com");
      rejects(validateHttpsDomainUrl, "https://localhost/path");
    });

    test("accepts zero and positive prices only", () => {
      accepts(validateNonNegativePrice, "0");
      accepts(validateNonNegativePrice, "12.34");
      rejects(validateNonNegativePrice, "-1");
      rejects(validateNonNegativePrice, "not-money");
    });

    test("validates non-negative whole numbers with the field label", () => {
      const validate = validateNonNegativeInteger("Capacity");
      accepts(validate, "0");
      accepts(validate, "2");
      expect(validate("-1")).toBe("Capacity must be 0 or greater");
      expect(validate("1.5")).toBe("Capacity must be 0 or greater");
    });
  });

  describe("validateEmail", () => {
    test("accepts a well-formed address", () => {
      accepts(validateEmail, "person@example.com");
    });
    test("accepts uppercase address parts", () => {
      accepts(validateEmail, "Person@Example.COM");
    });
    for (const bad of ["", "notanemail", "missing@domain", "@example.com"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => rejects(validateEmail, bad));
    }
  });

  describe("validatePhone", () => {
    test("accepts a plus-prefixed number", () => {
      accepts(validatePhone, "+441234567");
    });
    test("accepts a plain digit run with separators", () => {
      accepts(validatePhone, "01234 567 890");
    });
    test("rejects fewer than six characters", () => {
      // The pattern requires a lead char plus 5+ more.
      rejects(validatePhone, "12345");
    });
    test("accepts exactly six characters", () => {
      accepts(validatePhone, "123456");
    });
    for (const bad of ["", "abcdef", "phone!!"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => rejects(validatePhone, bad));
    }
  });

  describe("validateUsername", () => {
    test("rejects a single character (below the 2-char minimum)", () => {
      rejects(validateUsername, "a");
    });
    test("accepts exactly two characters", () => {
      accepts(validateUsername, "ab");
    });
    test("accepts exactly thirty-two characters", () => {
      accepts(validateUsername, "a".repeat(32));
    });
    test("rejects thirty-three characters (above the 32-char maximum)", () => {
      rejects(validateUsername, "a".repeat(33));
    });
    test("accepts letters, digits, hyphens and underscores together", () => {
      accepts(validateUsername, "Ab-9_z");
    });
    test("rejects other characters", () => {
      rejects(validateUsername, "ab!");
    });
    test("rejects a leading hyphen", () => {
      rejects(validateUsername, "-ab");
    });
    test("rejects a leading underscore", () => {
      rejects(validateUsername, "_ab");
    });
    test("accepts a hyphen or underscore that is not leading", () => {
      accepts(validateUsername, "a-_b");
    });
  });

  test("defines the exact username field contract", () => {
    expect(getUsernameFieldBase()).toMatchObject({
      maxlength: 32,
      minlength: 2,
      name: "username",
      pattern: "[a-zA-Z0-9_\\-]+",
      required: true,
      type: "text",
    });
  });

  describe("stored option validators", () => {
    test("accepts known contact fields and rejects unknown ones", () => {
      accepts(validateListingFields, "email, phone, address");
      expect(validateListingFields("email, unknown")).toContain("unknown");
    });

    test("accepts exact update tiers only", () => {
      for (const tier of ["alpha", "beta", "release"]) {
        accepts(validateUpdateTier, tier);
      }
      rejects(validateUpdateTier, "stable");
    });
  });

  describe("validateBookableDays", () => {
    test("rejects an empty selection", () => {
      rejects(validateBookableDays, "");
    });
    test("rejects a selection that is only separators", () => {
      // commaParts drops the empties, leaving nothing to book.
      rejects(validateBookableDays, " , , ");
    });
    test("rejects an unknown day name", () => {
      rejects(validateBookableDays, "Monday, Funday");
    });
    test("accepts valid, comma-separated day names", () => {
      accepts(validateBookableDays, "Monday, Wednesday, Friday");
    });
    test("VALID_DAY_NAMES lists all seven days, Monday first", () => {
      expect(VALID_DAY_NAMES).toHaveLength(7);
      expect(VALID_DAY_NAMES[0]).toBe("Monday");
      expect(VALID_DAY_NAMES[6]).toBe("Sunday");
    });
  });

  describe("validateDate", () => {
    test("accepts an ISO date", () => {
      accepts(validateDate, "2026-07-07");
    });
    for (const bad of ["", "07/07/2026", "2026-13-01", "not-a-date"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => rejects(validateDate, bad));
    }
  });

  describe("description and datetime fields", () => {
    test("validates descriptions at the configured limit", () => {
      accepts(validateDescription, "Short description");
      rejects(validateDescription, "x".repeat(MAX_TEXTAREA_LENGTH + 1));
    });

    test("keeps optional HTML hints in description fields", () => {
      expect(buildDescriptionField("Hint")).not.toHaveProperty("hintHtml");
      expect(buildDescriptionField("Hint", "<b>Hint</b>")).toMatchObject({
        hint: "Hint",
        hintHtml: "<b>Hint</b>",
        markdown: true,
        name: "description",
        type: "textarea",
      });
    });

    test("validates local datetimes", () => {
      accepts(validateDatetime, "2026-07-20T12:30");
      rejects(validateDatetime, "not-a-datetime");
    });

    test("uses distinct listing and group visibility copy", () => {
      const listing = buildHiddenField("Listing");
      const group = buildHiddenField("Group");
      expect(listing.name).toBe("hidden");
      expect(listing.hint).not.toBe(group.hint);
      expect(listing.label).not.toBe(group.label);
      expect(listing.options).toEqual([
        { label: "Hide from public listings list", value: "1" },
      ]);
    });
  });

  test("defines exact slug field constraints", () => {
    expect(slugFieldBase()).toMatchObject({
      name: "slug",
      pattern: "[a-z0-9_\\-]+",
      required: true,
      type: "text",
    });
    expect(getSlugField()).toHaveProperty("hint");
    expect(slugFieldBase().validate("Valid Slug")).toBeNull();
    rejects(slugFieldBase().validate, "!!!");
  });

  describe("length-bounded text validators", () => {
    // A short value must pass; a `maxLength(N) -> maxLength(0)` mutant would
    // reject it, so this pins the bound is actually a positive length.
    test("validateAddress accepts a short address", () => {
      accepts(validateAddress, "1 High Street");
    });
    test("validateAddress rejects an over-long address", () => {
      rejects(validateAddress, "x".repeat(5000));
    });
    test("validateSpecialInstructions accepts a short note", () => {
      accepts(validateSpecialInstructions, "No nuts please");
    });
    test("validateSpecialInstructions rejects an over-long note", () => {
      rejects(validateSpecialInstructions, "x".repeat(1000));
    });
  });
});
