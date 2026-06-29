import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectedItemPrice,
  type PackagePricing,
} from "#routes/api/payment-processing.ts";

const pkg: PackagePricing = {
  memberIds: new Set([1, 2]),
  priceMap: new Map([[1, 1500]]),
};
const item = (e: number, q = 1) => ({ e, p: 0, q });

describe("expectedItemPrice (package revalidation)", () => {
  test("a non-package booking uses the base price", () => {
    expect(expectedItemPrice(null, new Set(), item(1), 5000)).toBe(5000);
  });

  test("a folded child keeps the base price even when it's a member", () => {
    expect(expectedItemPrice(pkg, new Set([1]), item(1), 5000)).toBe(5000);
  });

  test("a non-member keeps the base price", () => {
    expect(expectedItemPrice(pkg, new Set(), item(9), 5000)).toBe(5000);
  });

  test("a member with a non-zero override is priced at override × qty", () => {
    expect(expectedItemPrice(pkg, new Set(), item(1, 3), 5000)).toBe(4500);
  });

  test("a member with no override falls back to the base price", () => {
    expect(expectedItemPrice(pkg, new Set(), item(2), 5000)).toBe(5000);
  });
});
