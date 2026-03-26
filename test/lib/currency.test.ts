import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  formatCurrency,
  getDecimalPlaces,
  toMajorUnits,
  toMinorUnits,
} from "#lib/currency.ts";
import { settings } from "#lib/db/settings.ts";
import {
  createTestDbWithSetup,
  resetDb,
  setupTestEncryptionKey,
} from "#test-utils";

describe("currency", () => {
  afterEach(() => {
    settings.clearTestOverride("currency");
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
    test("formats GBP with pound symbol", () => {
      settings.setForTest({ currency: "GBP" });
      expect(formatCurrency(1050)).toBe("£10.50");
    });

    test("formats GBP zero amount", () => {
      settings.setForTest({ currency: "GBP" });
      expect(formatCurrency(0)).toBe("£0");
    });

    test("formats USD with dollar symbol", () => {
      settings.setForTest({ currency: "USD" });
      expect(formatCurrency(1050)).toBe("$10.50");
    });

    test("formats EUR with euro symbol", () => {
      settings.setForTest({ currency: "EUR" });
      const result = formatCurrency(1050);
      expect(result).toContain("10.50");
      expect(result).toContain("€");
    });

    test("formats JPY without decimal places", () => {
      settings.setForTest({ currency: "JPY" });
      expect(formatCurrency(1050)).toBe("¥1,050");
    });

    test("formats KWD with 3 decimal places", () => {
      settings.setForTest({ currency: "KWD" });
      const result = formatCurrency(1050);
      expect(result).toContain("1.050");
    });

    test("accepts string input", () => {
      settings.setForTest({ currency: "GBP" });
      expect(formatCurrency("1050")).toBe("£10.50");
    });

    test("falls back to GBP when no currency loaded", () => {
      settings.clearTestOverride("currency");
      expect(formatCurrency(1050)).toBe("£10.50");
    });
  });

  describe("toMinorUnits", () => {
    test("converts GBP major to minor units", () => {
      settings.setForTest({ currency: "GBP" });
      expect(toMinorUnits(10.5)).toBe(1050);
    });

    test("converts whole number", () => {
      settings.setForTest({ currency: "GBP" });
      expect(toMinorUnits(25)).toBe(2500);
    });

    test("rounds to nearest integer", () => {
      settings.setForTest({ currency: "GBP" });
      expect(toMinorUnits(10.999)).toBe(1100);
    });

    test("converts JPY (no decimals)", () => {
      settings.setForTest({ currency: "JPY" });
      expect(toMinorUnits(1050)).toBe(1050);
    });

    test("converts KWD (3 decimals)", () => {
      settings.setForTest({ currency: "KWD" });
      expect(toMinorUnits(1.05)).toBe(1050);
    });
  });

  describe("toMajorUnits", () => {
    test("converts GBP minor to major units string", () => {
      settings.setForTest({ currency: "GBP" });
      expect(toMajorUnits(1050)).toBe("10.50");
    });

    test("converts zero", () => {
      settings.setForTest({ currency: "GBP" });
      expect(toMajorUnits(0)).toBe("0.00");
    });

    test("converts JPY (no decimals)", () => {
      settings.setForTest({ currency: "JPY" });
      expect(toMajorUnits(1050)).toBe("1050");
    });

    test("converts KWD (3 decimals)", () => {
      settings.setForTest({ currency: "KWD" });
      expect(toMajorUnits(1050)).toBe("1.050");
    });
  });

  describe("settings.currency integration", () => {
    beforeEach(async () => {
      setupTestEncryptionKey();
      await createTestDbWithSetup("US");
      await settings.loadAll();
      settings.clearTestOverride("currency");
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
