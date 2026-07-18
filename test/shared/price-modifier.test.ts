import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CalcKindSchema,
  ModifierDirectionSchema,
  ModifierScopeSchema,
  ModifierTriggerSchema,
  modifierDelta,
  normalizeCode,
  validateCalcValue,
} from "#shared/price-modifier.ts";

describe("modifier schemas", () => {
  test("lists every calculation kind", () => {
    expect(CalcKindSchema.options).toEqual(["fixed", "percent", "multiply"]);
  });

  test("lists every direction", () => {
    expect(ModifierDirectionSchema.options).toEqual(["charge", "discount"]);
  });

  test("lists every trigger", () => {
    expect(ModifierTriggerSchema.options).toEqual([
      "automatic",
      "code",
      "optional",
      "answer",
    ]);
  });

  test("lists every scope", () => {
    expect(ModifierScopeSchema.options).toEqual(["all", "listings", "groups"]);
  });
});

describe("normalizeCode", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeCode("  SAVE20  ")).toBe("save20");
  });

  test("lowercases the code", () => {
    expect(normalizeCode("SaVe20")).toBe("save20");
  });
});

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

describe("validateCalcValue", () => {
  test("rejects a non-finite value", () => {
    expect(validateCalcValue("fixed", Number.NaN, "charge")).toBe(
      "Enter a valid number",
    );
  });

  describe("percent", () => {
    test("accepts discounts above 0 up to 100", () => {
      expect(validateCalcValue("percent", 0.5, "discount")).toBeNull();
      expect(validateCalcValue("percent", 100, "discount")).toBeNull();
    });

    test("rejects zero, negative, and above-100 discounts", () => {
      const message = "Percentage must be greater than 0 and at most 100";
      expect(validateCalcValue("percent", 0, "discount")).toBe(message);
      expect(validateCalcValue("percent", -1, "discount")).toBe(message);
      expect(validateCalcValue("percent", 150, "discount")).toBe(message);
    });

    test("rejects exactly one past the upper boundary", () => {
      expect(validateCalcValue("percent", 101, "discount")).toBe(
        "Percentage must be greater than 0 and at most 100",
      );
    });

    test("accepts charges above 100", () => {
      expect(validateCalcValue("percent", 101, "charge")).toBeNull();
      expect(validateCalcValue("percent", 150, "charge")).toBeNull();
    });

    test("rejects a zero charge without claiming it is capped at 100", () => {
      expect(validateCalcValue("percent", 0, "charge")).toBe(
        "Percentage must be greater than 0",
      );
    });
  });

  describe("multiply", () => {
    test("accepts a positive factor", () => {
      expect(validateCalcValue("multiply", 1.5, "charge")).toBeNull();
    });

    test("accepts exactly the lower boundary", () => {
      expect(validateCalcValue("multiply", 1, "discount")).toBeNull();
    });

    test("rejects a non-positive factor", () => {
      expect(validateCalcValue("multiply", 0, "charge")).toBe(
        "Multiplier must be greater than 0",
      );
    });
  });

  describe("fixed", () => {
    test("accepts a positive amount", () => {
      expect(validateCalcValue("fixed", 500, "charge")).toBeNull();
    });

    test("accepts exactly the lower boundary", () => {
      expect(validateCalcValue("fixed", 1, "discount")).toBeNull();
    });

    test("rejects a non-positive amount", () => {
      expect(validateCalcValue("fixed", 0, "charge")).toBe(
        "Amount must be greater than 0",
      );
    });
  });
});
