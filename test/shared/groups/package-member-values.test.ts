/** The strict value rules one package member must satisfy. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isValidMemberDayPrices,
  isValidMemberPrice,
  isValidMemberQuantity,
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
    expect(isValidMemberDayPrices({ 1: 500, 2: 900 })).toBe(true);
    expect(isValidMemberDayPrices({ 1: 0 })).toBe(true);
    expect(isValidMemberDayPrices({})).toBe(true);
  });

  test("refuses a zero day count, a negative price, or a junk shape", () => {
    expect(isValidMemberDayPrices({ 0: 500 })).toBe(false);
    expect(isValidMemberDayPrices({ 1: -500 })).toBe(false);
    expect(isValidMemberDayPrices({ 1: 5.5 })).toBe(false);
    expect(isValidMemberDayPrices({ x: 500 })).toBe(false);
    expect(
      isValidMemberDayPrices({ [`${Number.MAX_SAFE_INTEGER}0`]: 500 }),
    ).toBe(false);
    expect(isValidMemberDayPrices(null)).toBe(false);
    expect(isValidMemberDayPrices([500])).toBe(false);
    expect(isValidMemberDayPrices("days")).toBe(false);
  });
});
