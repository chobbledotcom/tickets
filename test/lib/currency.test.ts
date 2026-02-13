import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  formatCurrency,
  getDecimalPlaces,
  loadCurrencyCode,
  resetCurrencyCode,
  setCurrencyCodeForTest,
  toMajorUnits,
  toMinorUnits,
} from "#lib/currency.ts";
import { createTestDbWithSetup, resetDb, setupTestEncryptionKey } from "#test-utils";

describe("currency", () => {
  afterEach(() => {
    resetCurrencyCode();
  });

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
  });

  describe("formatCurrency", () => {
    test("formats GBP with pound symbol", () => {
      setCurrencyCodeForTest("GBP");
      expect(formatCurrency(1050)).toBe("£10.50");
    });

    test("formats GBP zero amount", () => {
      setCurrencyCodeForTest("GBP");
      expect(formatCurrency(0)).toBe("£0.00");
    });

    test("formats USD with dollar symbol", () => {
      setCurrencyCodeForTest("USD");
      expect(formatCurrency(1050)).toBe("$10.50");
    });

    test("formats EUR with euro symbol", () => {
      setCurrencyCodeForTest("EUR");
      const result = formatCurrency(1050);
      expect(result).toContain("10.50");
      expect(result).toContain("€");
    });

    test("formats JPY without decimal places", () => {
      setCurrencyCodeForTest("JPY");
      expect(formatCurrency(1050)).toBe("¥1,050");
    });

    test("formats KWD with 3 decimal places", () => {
      setCurrencyCodeForTest("KWD");
      const result = formatCurrency(1050);
      expect(result).toContain("1.050");
    });

    test("accepts string input", () => {
      setCurrencyCodeForTest("GBP");
      expect(formatCurrency("1050")).toBe("£10.50");
    });

    test("falls back to GBP when no currency loaded", () => {
      resetCurrencyCode();
      expect(formatCurrency(1050)).toBe("£10.50");
    });
  });

  describe("toMinorUnits", () => {
    test("converts GBP major to minor units", () => {
      setCurrencyCodeForTest("GBP");
      expect(toMinorUnits(10.50)).toBe(1050);
    });

    test("converts whole number", () => {
      setCurrencyCodeForTest("GBP");
      expect(toMinorUnits(25)).toBe(2500);
    });

    test("rounds to nearest integer", () => {
      setCurrencyCodeForTest("GBP");
      expect(toMinorUnits(10.999)).toBe(1100);
    });

    test("converts JPY (no decimals)", () => {
      setCurrencyCodeForTest("JPY");
      expect(toMinorUnits(1050)).toBe(1050);
    });

    test("converts KWD (3 decimals)", () => {
      setCurrencyCodeForTest("KWD");
      expect(toMinorUnits(1.050)).toBe(1050);
    });
  });

  describe("toMajorUnits", () => {
    test("converts GBP minor to major units string", () => {
      setCurrencyCodeForTest("GBP");
      expect(toMajorUnits(1050)).toBe("10.50");
    });

    test("converts zero", () => {
      setCurrencyCodeForTest("GBP");
      expect(toMajorUnits(0)).toBe("0.00");
    });

    test("converts JPY (no decimals)", () => {
      setCurrencyCodeForTest("JPY");
      expect(toMajorUnits(1050)).toBe("1050");
    });

    test("converts KWD (3 decimals)", () => {
      setCurrencyCodeForTest("KWD");
      expect(toMajorUnits(1050)).toBe("1.050");
    });
  });

  describe("loadCurrencyCode", () => {
    beforeEach(async () => {
      setupTestEncryptionKey();
      await createTestDbWithSetup("USD");
      resetCurrencyCode();
    });

    afterEach(() => {
      resetDb();
    });

    test("loads currency code from database", async () => {
      const code = await loadCurrencyCode();
      expect(code).toBe("USD");
    });

    test("caches the result on subsequent calls", async () => {
      const first = await loadCurrencyCode();
      const second = await loadCurrencyCode();
      expect(first).toBe("USD");
      expect(second).toBe("USD");
    });

    test("uses loaded code for formatting", async () => {
      await loadCurrencyCode();
      expect(formatCurrency(1050)).toBe("$10.50");
    });
  });
});
