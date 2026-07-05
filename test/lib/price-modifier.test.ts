import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isCalcKind,
  isModifierDirection,
  isModifierScope,
  isModifierTrigger,
  modifierDelta,
  normalizeCode,
  validateCalcValue,
} from "#shared/price-modifier.ts";

describe("isCalcKind", () => {
  test("accepts every calc kind", () => {
    expect(isCalcKind("fixed")).toBe(true);
    expect(isCalcKind("percent")).toBe(true);
    expect(isCalcKind("multiply")).toBe(true);
  });

  test("rejects an unknown kind", () => {
    expect(isCalcKind("unknown")).toBe(false);
  });
});

describe("isModifierDirection", () => {
  test("accepts charge and discount", () => {
    expect(isModifierDirection("charge")).toBe(true);
    expect(isModifierDirection("discount")).toBe(true);
  });

  test("rejects an unknown direction", () => {
    expect(isModifierDirection("unknown")).toBe(false);
  });
});

describe("isModifierTrigger", () => {
  test("accepts every trigger", () => {
    expect(isModifierTrigger("automatic")).toBe(true);
    expect(isModifierTrigger("code")).toBe(true);
    expect(isModifierTrigger("optional")).toBe(true);
    expect(isModifierTrigger("answer")).toBe(true);
  });

  test("rejects an unknown trigger", () => {
    expect(isModifierTrigger("unknown")).toBe(false);
  });
});

describe("isModifierScope", () => {
  test("accepts every scope", () => {
    expect(isModifierScope("all")).toBe(true);
    expect(isModifierScope("listings")).toBe(true);
    expect(isModifierScope("groups")).toBe(true);
  });

  test("rejects an unknown scope", () => {
    expect(isModifierScope("unknown")).toBe(false);
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
    expect(validateCalcValue("fixed", Number.NaN)).toBe("Enter a valid number");
  });

  describe("percent", () => {
    test("accepts values above 0 up to 100", () => {
      expect(validateCalcValue("percent", 0.5)).toBeNull();
      expect(validateCalcValue("percent", 100)).toBeNull();
    });

    test("rejects zero, negative, and above-100 percentages", () => {
      const message = "Percentage must be greater than 0 and at most 100";
      expect(validateCalcValue("percent", 0)).toBe(message);
      expect(validateCalcValue("percent", -1)).toBe(message);
      expect(validateCalcValue("percent", 150)).toBe(message);
    });

    test("rejects exactly one past the upper boundary", () => {
      expect(validateCalcValue("percent", 101)).toBe(
        "Percentage must be greater than 0 and at most 100",
      );
    });
  });

  describe("multiply", () => {
    test("accepts a positive factor", () => {
      expect(validateCalcValue("multiply", 1.5)).toBeNull();
    });

    test("accepts exactly the lower boundary", () => {
      expect(validateCalcValue("multiply", 1)).toBeNull();
    });

    test("rejects a non-positive factor", () => {
      expect(validateCalcValue("multiply", 0)).toBe(
        "Multiplier must be greater than 0",
      );
    });
  });

  describe("fixed", () => {
    test("accepts a positive amount", () => {
      expect(validateCalcValue("fixed", 500)).toBeNull();
    });

    test("accepts exactly the lower boundary", () => {
      expect(validateCalcValue("fixed", 1)).toBeNull();
    });

    test("rejects a non-positive amount", () => {
      expect(validateCalcValue("fixed", 0)).toBe(
        "Amount must be greater than 0",
      );
    });
  });
});
