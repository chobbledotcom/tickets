import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import type { SettingsData } from "#shared/db/settings.ts";
import {
  exceedsCurrencyPrecision,
  parseNonNegativeMinorUnits,
  parseOptionalMinorUnits,
  parsePositiveMinorUnits,
  parseSignedMinorUnits,
  validatePrice,
} from "#shared/validation/money.ts";
import { testWithSetting } from "#test-utils/settings.ts";

/** Build a table-driven describe for one currency-aware parser. */
const parserTable =
  (parse: (raw: string) => number | null) =>
  (
    currency: SettingsData["currency"],
    rows: Array<[string, number | null]>,
  ) => {
    for (const [input, expected] of rows) {
      testWithSetting(
        `${currency}: ${JSON.stringify(input)} → ${expected}`,
        { currency },
        () => {
          expect(parse(input)).toBe(expected);
        },
      );
    }
  };

/**
 * Currency-aware money parsing. The invariant under test is that the accepted
 * number of decimal places tracks the active currency: an amount carrying more
 * fractional digits than the currency allows must be REJECTED (null), never
 * silently rounded/truncated into minor units.
 */
describe("parsePositiveMinorUnits", () => {
  const table = (
    currency: SettingsData["currency"],
    rows: Array<[string, number | null]>,
  ): void => {
    for (const [input, expected] of rows) {
      testWithSetting(
        `${currency}: ${JSON.stringify(input)} → ${expected}`,
        { currency },
        () => {
          expect(parsePositiveMinorUnits(input)).toBe(expected);
        },
      );
    }
  };

  // GBP — 2 decimal places.
  table("GBP", [
    ["90.00", 9000],
    ["90", 9000],
    ["0.01", 1],
    ["10.5", 1050],
    // The fractional-rounding bug: 3 dp in a 2 dp currency must be rejected,
    // not rounded to 101 pence.
    ["1.005", null],
    ["1.001", null],
    ["", null],
    ["-5", null],
    ["abc", null],
    ["0", null],
    ["0.00", null],
    // Number() / parseFloat leniency the strict pattern closes.
    ["1,000", null],
    ["1,000.00", null],
    ["12.34abc", null],
    ["  10.50  ", 1050], // trimmed before validating
    // Minor units beyond Number.MAX_SAFE_INTEGER are rejected.
    ["99999999999999999", null],
  ]);

  // JPY — 0 decimal places: any fraction is rejected.
  table("JPY", [
    ["1", 1],
    ["1050", 1050],
    ["1.23", null],
    ["1.0", null],
    ["0", null],
  ]);

  // KWD — 3 decimal places: 3 dp is valid, 4 dp is rejected.
  table("KWD", [
    ["1.005", 1005],
    ["1.5", 1500],
    ["1.0005", null],
    ["0", null],
  ]);
});

describe("parseNonNegativeMinorUnits (required; blank ⇒ 0)", () => {
  const table = parserTable(parseNonNegativeMinorUnits);
  table("GBP", [
    ["", 0], // blank is a real zero
    ["0", 0],
    ["0.00", 0],
    ["10.50", 1050],
    ["-1", null], // negative rejected
    ["1.005", null], // extra decimal rejected, not rounded
    ["abc", null],
    ["1,000", null],
  ]);
  table("JPY", [
    ["", 0],
    ["1000", 1000],
    ["1.5", null],
  ]);
});

describe("parseOptionalMinorUnits (optional; blank ⇒ null, never 0)", () => {
  const table = parserTable(parseOptionalMinorUnits);
  table("GBP", [
    ["", null], // unset, NOT a real zero
    ["0", 0], // an explicit zero is kept
    ["12.34", 1234],
    ["-1", null],
    ["1.005", null],
    ["nope", null],
  ]);
  table("KWD", [
    ["", null],
    ["1.005", 1005],
    ["1.0005", null],
  ]);
});

describe("parseSignedMinorUnits (signed; negatives + zero allowed)", () => {
  const table = parserTable(parseSignedMinorUnits);
  table("GBP", [
    ["10.50", 1050],
    ["0", 0],
    ["-10.50", -1050], // a negative correction is valid
    ["-0.01", -1],
    ["", null], // blank rejected — a correction needs a figure
    ["1.005", null],
    ["--1", null],
    ["abc", null],
  ]);
  table("JPY", [
    ["-100", -100],
    ["-1.5", null],
  ]);
});

describe("validatePrice (bounded public/QR price)", () => {
  testWithSetting(
    "blank ⇒ 0 when minPrice is 0 (pay-what-you-want)",
    { currency: "GBP" },
    () => {
      expect(validatePrice("", 0, 100_000)).toEqual({ ok: true, price: 0 });
    },
  );

  testWithSetting(
    "blank ⇒ error when a minimum is required",
    { currency: "GBP" },
    () => {
      expect(validatePrice("", 500, 100_000)).toEqual({
        error: "Please enter a price",
        ok: false,
      });
    },
  );

  testWithSetting("rejects non-numeric input", { currency: "GBP" }, () => {
    expect(validatePrice("abc", 0, 100_000)).toEqual({
      error: "Please enter a valid price",
      ok: false,
    });
  });

  testWithSetting("rejects a negative price", { currency: "GBP" }, () => {
    expect(validatePrice("-5", 0, 100_000).ok).toBe(false);
  });

  testWithSetting(
    "rejects a leading-numeric prefix (12abc), not parseFloat-coerced",
    { currency: "GBP" },
    () => {
      // The old Number.parseFloat accepted "12abc" as 12; the currency-aware
      // parser rejects the trailing junk.
      expect(validatePrice("12abc", 0, 100_000)).toEqual({
        error: "Please enter a valid price",
        ok: false,
      });
    },
  );

  testWithSetting(
    "rejects a comma-grouped amount (1,000)",
    { currency: "GBP" },
    () => {
      expect(validatePrice("1,000", 0, 1_000_000).ok).toBe(false);
    },
  );

  testWithSetting(
    "rejects an over-precise amount (1.005 GBP), not rounded",
    { currency: "GBP" },
    () => {
      expect(validatePrice("1.005", 0, 100_000).ok).toBe(false);
    },
  );

  testWithSetting(
    "accepts an in-range price ⇒ minor units",
    { currency: "GBP" },
    () => {
      expect(validatePrice("10", 0, 100_000)).toEqual({
        ok: true,
        price: 1000,
      });
    },
  );

  testWithSetting(
    "rejects a price below the minimum",
    { currency: "GBP" },
    () => {
      expect(validatePrice("1", 500, 100_000)).toEqual({
        error: "Price must be at least the minimum ticket price",
        ok: false,
      });
    },
  );

  testWithSetting(
    "rejects a price above the maximum",
    { currency: "GBP" },
    () => {
      expect(validatePrice("2000", 0, 100_000)).toEqual({
        error: "Price exceeds the maximum allowed",
        ok: false,
      });
    },
  );

  testWithSetting(
    "accepts a price exactly on the min and max bounds",
    { currency: "GBP" },
    () => {
      expect(validatePrice("5", 500, 500)).toEqual({ ok: true, price: 500 });
    },
  );
});

describe("exceedsCurrencyPrecision (already-parsed major-unit amount)", () => {
  const table = (
    currency: SettingsData["currency"],
    rows: Array<[number, boolean]>,
  ) => {
    for (const [value, expected] of rows) {
      testWithSetting(
        `${currency}: ${value} → ${expected}`,
        { currency },
        () => {
          expect(exceedsCurrencyPrecision(value)).toBe(expected);
        },
      );
    }
  };

  // GBP allows 2 decimals: 3+ is over-precise, an integer or ≤2 dp is not.
  table("GBP", [
    [10, false],
    [10.1, false],
    [10.01, false],
    [10.005, true],
    [10.999, true],
  ]);

  // JPY has no minor unit, so any fraction is over-precise.
  table("JPY", [
    [10, false],
    [10.5, true],
  ]);

  // KWD allows 3 decimals.
  table("KWD", [
    [1.005, false],
    [1.0005, true],
  ]);
});
