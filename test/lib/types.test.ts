import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getMaxPrice,
  DEFAULT_MAX_PRICE,
} from "#lib/types.ts";

describe("getMaxPrice", () => {
  test("returns configured max_price when set", () => {
    expect(getMaxPrice({ max_price: 50000 })).toBe(50000);
  });

  test("returns configured max_price even when small", () => {
    expect(getMaxPrice({ max_price: 100 })).toBe(100);
  });

  test("returns default when max_price is 0", () => {
    expect(getMaxPrice({ max_price: 0 })).toBe(DEFAULT_MAX_PRICE);
  });

  test("default max price constant has expected value", () => {
    expect(DEFAULT_MAX_PRICE).toBe(10000);
  });
});
