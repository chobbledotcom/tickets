import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import type { SettingsData } from "#shared/db/settings.ts";
import { parsePositiveMinorUnits } from "#shared/validation/money.ts";
import { testWithSetting } from "#test-utils";

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
