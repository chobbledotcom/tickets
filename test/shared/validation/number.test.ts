import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  clampInteger,
  parseNonNegativeInt,
  parsePositiveInt,
} from "#shared/validation/number.ts";

describe("clampInteger", () => {
  const clampDays = clampInteger(1, 90);

  test("clamps valid integers outside the range", () => {
    expect(clampDays(-2)).toBe(1);
    expect(clampDays(500)).toBe(90);
  });

  test("leaves valid integers within the range unchanged", () => {
    expect(clampDays(37)).toBe(37);
  });

  test("rejects malformed numbers", () => {
    for (const value of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => clampDays(value)).toThrow();
    }
  });
});

describe("parseNonNegativeInt", () => {
  test("accepts zero and positive decimal integers, including leading zeros", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
    expect(parseNonNegativeInt("12")).toBe(12);
    expect(parseNonNegativeInt("007")).toBe(7);
    expect(parseNonNegativeInt(" 12 ")).toBe(12);
  });

  test("rejects signs, fractions, exponents and trailing junk", () => {
    for (const value of ["", "-1", "+1", "1.5", "1e2", "2x"]) {
      expect(parseNonNegativeInt(value)).toBeNull();
    }
  });

  test("rejects integers above JavaScript's safe range", () => {
    expect(parseNonNegativeInt(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });
});

describe("parsePositiveInt", () => {
  test("accepts positive plain decimal integers", () => {
    expect(parsePositiveInt("1")).toBe(1);
    expect(parsePositiveInt("007")).toBe(7);
    expect(parsePositiveInt(" 7 ")).toBe(7);
  });

  test("rejects zero, signs, fractions, exponents and trailing junk", () => {
    for (const value of ["0", "-1", "+1", "1.5", "1e2", "1abc"]) {
      expect(parsePositiveInt(value)).toBeNull();
    }
  });
});
