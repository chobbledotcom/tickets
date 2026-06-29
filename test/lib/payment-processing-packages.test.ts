import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectedItemPrice,
  type PackagePricing,
} from "#routes/api/payment-processing.ts";

const pkg: PackagePricing = {
  memberIds: new Set([1, 2]),
  priceMap: new Map([[1, 1500]]),
  quantityMap: new Map([
    [1, 1],
    [2, 1],
  ]),
};
const item = (e: number, q = 1) => ({ e, p: 0, q });

describe("expectedItemPrice (package revalidation)", () => {
  test("a non-package booking uses the base price", () => {
    expect(expectedItemPrice(null, false, new Set(), item(1), 5000)).toBe(5000);
  });

  test("a folded child keeps the base price even when it's a member", () => {
    expect(expectedItemPrice(pkg, true, new Set([1]), item(1), 5000)).toBe(
      5000,
    );
  });

  test("a member with a non-zero override is priced at override × qty", () => {
    expect(expectedItemPrice(pkg, true, new Set(), item(1, 3), 5000)).toBe(
      4500,
    );
  });

  test("a member with no override falls back to the base price", () => {
    expect(expectedItemPrice(pkg, true, new Set(), item(2), 5000)).toBe(5000);
  });

  test("a package line that is no longer a member fails closed", () => {
    expect(expectedItemPrice(pkg, true, new Set(), item(9), 5000)).toBeNull();
  });

  test("a package whose group was deleted/unflagged fails closed", () => {
    expect(expectedItemPrice(null, true, new Set(), item(1), 5000)).toBeNull();
  });

  test("a member whose per-package quantity grew mid-checkout fails closed", () => {
    const grown: PackagePricing = {
      memberIds: new Set([1]),
      priceMap: new Map([[1, 1500]]),
      quantityMap: new Map([[1, 3]]),
    };
    // Signed q=1 (booked when one package needed 1) is no longer a whole number
    // of packages now that it needs 3 → fail closed.
    expect(
      expectedItemPrice(grown, true, new Set(), item(1, 1), 5000),
    ).toBeNull();
  });

  test("a member missing from the quantity map defaults to 1 per package", () => {
    const noQty: PackagePricing = {
      memberIds: new Set([1]),
      priceMap: new Map([[1, 1500]]),
      quantityMap: new Map(),
    };
    expect(expectedItemPrice(noQty, true, new Set(), item(1, 2), 5000)).toBe(
      3000,
    );
  });
});
