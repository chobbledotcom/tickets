import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import {
  splitCsv,
  validateAddress,
  validateBookableDays,
  validateDate,
  validateEmail,
  validatePhone,
  validateSpecialInstructions,
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

  describe("splitCsv", () => {
    test("trims tokens and drops empty ones", () => {
      expect(splitCsv("a, b ,,  , c")).toEqual(["a", "b", "c"]);
    });
    test("returns an empty array for a blank string", () => {
      expect(splitCsv("   ")).toEqual([]);
    });
    test("keeps a single token", () => {
      expect(splitCsv("Monday")).toEqual(["Monday"]);
    });
  });

  describe("validateBookableDays", () => {
    test("rejects an empty selection", () => {
      rejects(validateBookableDays, "");
    });
    test("rejects a selection that is only separators", () => {
      // splitCsv drops the empties, leaving nothing to book.
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
