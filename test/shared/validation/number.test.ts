import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveIntId,
} from "#shared/validation/number.ts";

describe("parsePositiveIntId", () => {
  test("parses plain positive integers, dropping leading zeros", () => {
    expect(parsePositiveIntId("5")).toBe(5);
    expect(parsePositiveIntId("12")).toBe(12);
    expect(parsePositiveIntId("007")).toBe(7);
  });

  test("rejects zero, blanks and non-digit junk", () => {
    expect(parsePositiveIntId("0")).toBeNull();
    expect(parsePositiveIntId("")).toBeNull();
    expect(parsePositiveIntId("5abc")).toBeNull();
    expect(parsePositiveIntId("abc")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(parsePositiveIntId(" 5")).toBe(5);
    expect(parsePositiveIntId("5 ")).toBe(5);
  });

  test("rejects signs", () => {
    expect(parsePositiveIntId("-2")).toBeNull();
    expect(parsePositiveIntId("+5")).toBeNull();
  });
});

describe("parseNonNegativeInt", () => {
  test("accepts zero and positive plain decimal integers", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
    expect(parseNonNegativeInt("12")).toBe(12);
    expect(parseNonNegativeInt(" 12 ")).toBe(12);
  });

  test("rejects signs, fractions, exponents and trailing junk", () => {
    for (const value of ["", "-1", "+1", "1.5", "1e2", "2x"]) {
      expect(parseNonNegativeInt(value)).toBeNull();
    }
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
