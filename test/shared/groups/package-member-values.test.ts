/** The strict value rules one package member must satisfy. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isValidMemberPrice,
  isValidMemberQuantity,
  memberDayPricesFault,
  wholeNumberValue,
} from "#shared/groups/package-member-values.ts";

describe("package member value rules", () => {
  test("accepts no price override, a free member, and a whole price", () => {
    expect(isValidMemberPrice(null)).toBe(true);
    expect(isValidMemberPrice(0)).toBe(true);
    expect(isValidMemberPrice(450)).toBe(true);
  });

  test("refuses a price that is negative, fractional, or not a number", () => {
    expect(isValidMemberPrice(-1)).toBe(false);
    expect(isValidMemberPrice(4.5)).toBe(false);
    expect(isValidMemberPrice("450")).toBe(false);
    expect(isValidMemberPrice(undefined)).toBe(false);
    expect(isValidMemberPrice(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  test("accepts a quantity of one or more whole units", () => {
    expect(isValidMemberQuantity(1)).toBe(true);
    expect(isValidMemberQuantity(12)).toBe(true);
  });

  test("refuses a quantity below one, fractional, or not a number", () => {
    expect(isValidMemberQuantity(0)).toBe(false);
    expect(isValidMemberQuantity(-2)).toBe(false);
    expect(isValidMemberQuantity(1.5)).toBe(false);
    expect(isValidMemberQuantity("2")).toBe(false);
    expect(isValidMemberQuantity(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  test("accepts whole day counts of one or more with whole prices", () => {
    expect(memberDayPricesFault({ 1: 500, 2: 900 })).toBeNull();
    expect(memberDayPricesFault({ 1: 0 })).toBeNull();
    expect(memberDayPricesFault({})).toBeNull();
  });

  test("names the day counts as the broken part", () => {
    expect(memberDayPricesFault({ 0: 500 })).toBe("days");
    expect(memberDayPricesFault({ x: 500 })).toBe("days");
    expect(memberDayPricesFault({ [`${Number.MAX_SAFE_INTEGER}0`]: 500 })).toBe(
      "days",
    );
  });

  test("names the prices as the broken part", () => {
    expect(memberDayPricesFault({ 1: -500 })).toBe("prices");
    expect(memberDayPricesFault({ 1: 5.5 })).toBe("prices");
    expect(memberDayPricesFault({ 1: "500" })).toBe("prices");
    expect(memberDayPricesFault({ 1: null })).toBe("prices");
  });

  test("parses plain digits and refuses every other spelling", () => {
    expect(wholeNumberValue("10")).toBe(10);
    expect(wholeNumberValue("007")).toBe(7);
    expect(wholeNumberValue("1e1")).toBeNull();
    expect(wholeNumberValue("0x10")).toBeNull();
    expect(wholeNumberValue("1.5e1")).toBeNull();
    expect(wholeNumberValue("")).toBeNull();
    expect(wholeNumberValue("-2")).toBeNull();
    expect(wholeNumberValue("1,50")).toBeNull();
    expect(wholeNumberValue(" 2")).toBeNull();
  });
});
