import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { modifierDelta } from "#shared/price-modifier.ts";

describe("modifierDelta", () => {
  describe("fixed", () => {
    test("returns the flat value regardless of base", () => {
      expect(modifierDelta(5000, "fixed", 500)).toBe(500);
      expect(modifierDelta(0, "fixed", 500)).toBe(500);
    });

    test("returns a negative value for a fixed discount", () => {
      expect(modifierDelta(5000, "fixed", -500)).toBe(-500);
    });
  });

  describe("percent", () => {
    test("takes the percentage of the base", () => {
      expect(modifierDelta(5000, "percent", 10)).toBe(500);
    });

    test("rounds to the nearest minor unit", () => {
      // 999 * 1.5% = 14.985 → 15
      expect(modifierDelta(999, "percent", 1.5)).toBe(15);
    });

    test("returns a negative value for a percentage discount", () => {
      expect(modifierDelta(5000, "percent", -10)).toBe(-500);
    });
  });

  describe("multiply", () => {
    test("raises the price for a factor above 1", () => {
      // 5000 * 1.2 = 6000 → +1000
      expect(modifierDelta(5000, "multiply", 1.2)).toBe(1000);
    });

    test("reduces the price for a factor below 1", () => {
      // 5000 * 0.9 = 4500 → -500
      expect(modifierDelta(5000, "multiply", 0.9)).toBe(-500);
    });

    test("rounds the scaled amount before taking the difference", () => {
      // round(333 * 1.5) - 333 = round(499.5) - 333 = 500 - 333 = 167
      expect(modifierDelta(333, "multiply", 1.5)).toBe(167);
    });
  });
});
