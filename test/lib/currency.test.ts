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

  describe("settings.currency integration", () => {
    beforeEach(async () => {
      setupTestEncryptionKey();
      await createTestDbWithSetup("US");
      await settings.loadAll();
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
