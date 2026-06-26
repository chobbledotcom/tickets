import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  formatCurrency,
  getDecimalPlaces,
  parsePositiveMinorUnits,
  toMajorUnits,
  toMinorUnits,
  validatePrice,
} from "#shared/currency.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import {
  createTestDbWithSetup,
  resetDb,
  setupTestEncryptionKey,
  testWithSetting,
} from "#test-utils";

describe("currency", () => {
  describe("getDecimalPlaces", () => {
    test("returns 2 for GBP", () => {
      expect(getDecimalPlaces("GBP")).toBe(2);
    });

    test("returns 2 for USD", () => {
      expect(getDecimalPlaces("USD")).toBe(2);
    });

    test("returns 2 for EUR", () => {
      expect(getDecimalPlaces("EUR")).toBe(2);
    });

    test("returns 0 for JPY", () => {
      expect(getDecimalPlaces("JPY")).toBe(0);
    });

    test("returns 3 for KWD", () => {
      expect(getDecimalPlaces("KWD")).toBe(3);
    });

    test("falls back to 2 when minimumFractionDigits is undefined", () => {
      const orig = Intl.NumberFormat.prototype.resolvedOptions;
      Intl.NumberFormat.prototype.resolvedOptions = function () {
        const opts = orig.call(this);
        return {
          ...opts,
          minimumFractionDigits: undefined as unknown as number,
        };
      };
      try {
        expect(getDecimalPlaces("GBP")).toBe(2);
      } finally {
        Intl.NumberFormat.prototype.resolvedOptions = orig;
      }
    });
  });

  describe("formatCurrency", () => {
    testWithSetting(
      "formats GBP with pound symbol",
      { currency: "GBP" },
      () => {
        expect(formatCurrency(1050)).toBe("£10.50");
      },
    );

    testWithSetting("formats GBP zero amount", { currency: "GBP" }, () => {
      expect(formatCurrency(0)).toBe("£0");
    });

    testWithSetting(
      "formats USD with dollar symbol",
      { currency: "USD" },
      () => {
        expect(formatCurrency(1050)).toBe("$10.50");
      },
    );

    testWithSetting("formats EUR with euro symbol", { currency: "EUR" }, () => {
      const result = formatCurrency(1050);
      expect(result).toContain("10.50");
      expect(result).toContain("€");
    });

    testWithSetting(
      "formats JPY without decimal places",
      { currency: "JPY" },
      () => {
        expect(formatCurrency(1050)).toBe("¥1,050");
      },
    );

    testWithSetting(
      "formats KWD with 3 decimal places",
      { currency: "KWD" },
      () => {
        const result = formatCurrency(1050);
        expect(result).toContain("1.050");
      },
    );

    testWithSetting("accepts string input", { currency: "GBP" }, () => {
      expect(formatCurrency("1050")).toBe("£10.50");
    });

    test("falls back to GBP when no currency loaded", () => {
      expect(formatCurrency(1050)).toBe("£10.50");
    });
  });

  describe("toMinorUnits", () => {
    testWithSetting(
      "converts GBP major to minor units",
      { currency: "GBP" },
      () => {
        expect(toMinorUnits(10.5)).toBe(1050);
      },
    );

    testWithSetting("converts whole number", { currency: "GBP" }, () => {
      expect(toMinorUnits(25)).toBe(2500);
    });

    testWithSetting("rounds to nearest integer", { currency: "GBP" }, () => {
      expect(toMinorUnits(10.999)).toBe(1100);
    });

    testWithSetting("converts JPY (no decimals)", { currency: "JPY" }, () => {
      expect(toMinorUnits(1050)).toBe(1050);
    });

    testWithSetting("converts KWD (3 decimals)", { currency: "KWD" }, () => {
      expect(toMinorUnits(1.05)).toBe(1050);
    });
  });

  describe("toMajorUnits", () => {
    testWithSetting(
      "converts GBP minor to major units string",
      { currency: "GBP" },
      () => {
        expect(toMajorUnits(1050)).toBe("10.50");
      },
    );

    testWithSetting("converts zero", { currency: "GBP" }, () => {
      expect(toMajorUnits(0)).toBe("0.00");
    });

    testWithSetting("converts JPY (no decimals)", { currency: "JPY" }, () => {
      expect(toMajorUnits(1050)).toBe("1050");
    });

    testWithSetting("converts KWD (3 decimals)", { currency: "KWD" }, () => {
      expect(toMajorUnits(1050)).toBe("1.050");
    });
  });

  describe("parsePositiveMinorUnits", () => {
    testWithSetting(
      "parses a valid positive amount",
      { currency: "GBP" },
      () => {
        expect(parsePositiveMinorUnits("90.00")).toBe(9000);
      },
    );

    testWithSetting("returns null for empty", { currency: "GBP" }, () => {
      expect(parsePositiveMinorUnits("")).toBeNull();
    });

    testWithSetting("returns null for negative", { currency: "GBP" }, () => {
      expect(parsePositiveMinorUnits("-5")).toBeNull();
    });

    testWithSetting("returns null for non-numeric", { currency: "GBP" }, () => {
      expect(parsePositiveMinorUnits("abc")).toBeNull();
    });

    testWithSetting("returns null for zero", { currency: "GBP" }, () => {
      expect(parsePositiveMinorUnits("0")).toBeNull();
    });

    testWithSetting(
      "returns null for an amount that exceeds safe integer minor units",
      { currency: "GBP" },
      () => {
        // A huge major-unit amount whose minor-unit representation exceeds
        // Number.MAX_SAFE_INTEGER — the guard rejects it.
        expect(parsePositiveMinorUnits("99999999999999999")).toBeNull();
      },
    );
  });

  describe("validatePrice", () => {
    // GBP → 2 decimal places, so toMinorUnits multiplies major units by 100.
    testWithSetting(
      "accepts empty input as 0 when the minimum is 0 (pay-what-you-want)",
      { currency: "GBP" },
      () => {
        expect(validatePrice("", 0, 100_000)).toEqual({ ok: true, price: 0 });
      },
    );

    testWithSetting(
      "rejects empty input when a minimum is required",
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
      expect(validatePrice("-5", 0, 100_000)).toEqual({
        error: "Please enter a valid price",
        ok: false,
      });
    });

    testWithSetting(
      "accepts an in-range price and converts it to minor units",
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
        // £1 = 100 minor units, below the 500 minimum.
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
        // £2000 = 200000 minor units, above the 100000 maximum.
        expect(validatePrice("2000", 0, 100_000)).toEqual({
          error: "Price exceeds the maximum allowed",
          ok: false,
        });
      },
    );

    testWithSetting(
      "accepts a price exactly on the minimum and maximum bounds",
      { currency: "GBP" },
      () => {
        // The guards are strict (< / >), so priceMinor === min === max passes.
        expect(validatePrice("5", 500, 500)).toEqual({ ok: true, price: 500 });
      },
    );
  });

  describe("settings.currency integration", () => {
    beforeEach(async () => {
      setupTestEncryptionKey();
      await createTestDbWithSetup("US");
      await settings.loadKeys(ALL_SETTINGS_KEYS);
    });

    afterEach(() => {
      resetDb();
    });

    test("reads currency from settings", () => {
      expect(settings.currency).toBe("USD");
    });

    test("uses settings currency for formatting", () => {
      expect(formatCurrency(1050)).toBe("$10.50");
    });
  });
});
