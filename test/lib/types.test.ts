import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getMaxPrice } from "#lib/types.ts";

describe("getMaxPrice", () => {
  test("returns the event max_price", () => {
    expect(getMaxPrice({ max_price: 50000 })).toBe(50000);
  });

  test("returns max_price for small values", () => {
    expect(getMaxPrice({ max_price: 100 })).toBe(100);
  });
});
