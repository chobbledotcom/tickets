import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  canPayMoreMaxPrice,
  CAN_PAY_MORE_ABS_MIN,
  CAN_PAY_MORE_MULTIPLIER,
} from "#lib/types.ts";

describe("canPayMoreMaxPrice", () => {
  test("returns absolute minimum when 10x price is lower", () => {
    // 500 * 10 = 5000, which is less than 10000
    expect(canPayMoreMaxPrice(500)).toBe(CAN_PAY_MORE_ABS_MIN);
  });

  test("returns 10x price when it exceeds absolute minimum", () => {
    // 2000 * 10 = 20000, which is greater than 10000
    expect(canPayMoreMaxPrice(2000)).toBe(2000 * CAN_PAY_MORE_MULTIPLIER);
  });

  test("returns absolute minimum for zero price", () => {
    expect(canPayMoreMaxPrice(0)).toBe(CAN_PAY_MORE_ABS_MIN);
  });

  test("returns absolute minimum at the boundary (price = 1000)", () => {
    // 1000 * 10 = 10000, which equals the absolute minimum
    expect(canPayMoreMaxPrice(1000)).toBe(CAN_PAY_MORE_ABS_MIN);
  });

  test("returns 10x price just above the boundary", () => {
    // 1001 * 10 = 10010, which is greater than 10000
    expect(canPayMoreMaxPrice(1001)).toBe(1001 * CAN_PAY_MORE_MULTIPLIER);
  });

  test("constants have expected values", () => {
    expect(CAN_PAY_MORE_ABS_MIN).toBe(10000);
    expect(CAN_PAY_MORE_MULTIPLIER).toBe(10);
  });
});
