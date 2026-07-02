import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectedItemPrice,
  type PackagePricing,
  packageBundleMismatch,
} from "#routes/api/payment-processing.ts";

const pkg: PackagePricing = {
  dayPriceMap: new Map([[2, new Map([[2, 700]])]]),
  memberIds: new Set([1, 2]),
  priceMap: new Map([[1, 1500]]),
  quantityMap: new Map([
    [1, 1],
    [2, 1],
  ]),
};
const item = (e: number, q = 1) => ({ e, p: 0, q });

/** The checkout's non-customisable default: day count 1, no day pricing. */
const price = (
  p: PackagePricing | null,
  isPackage: boolean,
  folded: Set<number>,
  line: { e: number; p: number; q: number },
  base: number,
) => expectedItemPrice(p, isPackage, folded, line, base, false, 1);

describe("expectedItemPrice (package revalidation)", () => {
  test("a non-package booking uses the base price", () => {
    expect(price(null, false, new Set(), item(1), 5000)).toBe(5000);
  });

  test("a folded child keeps the base price even when it's a member", () => {
    expect(price(pkg, true, new Set([1]), item(1), 5000)).toBe(5000);
  });

  test("a member with a non-zero override is priced at override × qty", () => {
    expect(price(pkg, true, new Set(), item(1, 3), 5000)).toBe(4500);
  });

  test("a member with no override falls back to the base price", () => {
    expect(price(pkg, true, new Set(), item(2), 5000)).toBe(5000);
  });

  test("a package line that is no longer a member fails closed", () => {
    expect(price(pkg, true, new Set(), item(9), 5000)).toBeNull();
  });

  test("a package whose group was deleted/unflagged fails closed", () => {
    expect(price(null, true, new Set(), item(1), 5000)).toBeNull();
  });

  test("a customisable member's per-day override prices override × qty", () => {
    expect(
      expectedItemPrice(pkg, true, new Set(), item(2, 3), 5000, true, 2),
    ).toBe(2100);
  });

  test("a customisable member without an override for the chosen span keeps the (day-priced) base", () => {
    expect(
      expectedItemPrice(pkg, true, new Set(), item(2), 5000, true, 3),
    ).toBe(5000);
  });

  test("a flat override outranks a per-day override, mirroring the checkout", () => {
    const flatAndDay: PackagePricing = {
      ...pkg,
      dayPriceMap: new Map([[1, new Map([[2, 700]])]]),
    };
    expect(
      expectedItemPrice(flatAndDay, true, new Set(), item(1), 5000, true, 2),
    ).toBe(1500);
  });

  test("a day override never applies to a non-customisable member", () => {
    expect(
      expectedItemPrice(pkg, true, new Set(), item(2), 5000, false, 2),
    ).toBe(5000);
  });
});

describe("packageBundleMismatch (order-level revalidation)", () => {
  // Members 1 (×1 per package) and 2 (×2 per package).
  const bundle: PackagePricing = {
    dayPriceMap: new Map(),
    memberIds: new Set([1, 2]),
    priceMap: new Map([[1, 1500]]),
    quantityMap: new Map([
      [1, 1],
      [2, 2],
    ]),
  };

  test("a matching bundle (one common package count) is not a mismatch", () => {
    // 2 packages → member 1 ×2, member 2 ×4: both imply count 2.
    expect(
      packageBundleMismatch(bundle, [item(1, 2), item(2, 4)], new Set()),
    ).toBe(false);
  });

  test("a missing member (one added since checkout) is a mismatch", () => {
    expect(packageBundleMismatch(bundle, [item(1, 1)], new Set())).toBe(true);
  });

  test("an extra non-member line is a mismatch", () => {
    expect(
      packageBundleMismatch(
        bundle,
        [item(1, 1), item(2, 2), item(9, 1)],
        new Set(),
      ),
    ).toBe(true);
  });

  test("a non-member line substituted for a member is a mismatch", () => {
    // Same line count as the bundle, but listing 9 stands in for member 2.
    expect(
      packageBundleMismatch(bundle, [item(1, 1), item(9, 2)], new Set()),
    ).toBe(true);
  });

  test("a member whose quantity is no longer a whole package count is a mismatch", () => {
    // Member 2 needs ×2 per package, but q=3 is not a multiple of 2.
    expect(
      packageBundleMismatch(bundle, [item(1, 1), item(2, 3)], new Set()),
    ).toBe(true);
  });

  test("members implying different package counts is a mismatch", () => {
    // Member 1 ×1 → count 1; member 2 ×4 → count 2.
    expect(
      packageBundleMismatch(bundle, [item(1, 1), item(2, 4)], new Set()),
    ).toBe(true);
  });

  test("folded children are excluded from the bundle comparison", () => {
    // The folded child (id 9) is ignored; the remaining lines match the bundle.
    expect(
      packageBundleMismatch(
        bundle,
        [item(1, 1), item(2, 2), item(9, 5)],
        new Set([9]),
      ),
    ).toBe(false);
  });

  test("a member missing from the quantity map defaults to 1 per package", () => {
    const noQty: PackagePricing = {
      dayPriceMap: new Map(),
      memberIds: new Set([1]),
      priceMap: new Map(),
      quantityMap: new Map(),
    };
    // Default ×1, q=2 → count 2 (a whole number), so a lone member matches.
    expect(packageBundleMismatch(noQty, [item(1, 2)], new Set())).toBe(false);
  });

  test("a zero-quantity line is a mismatch", () => {
    const solo: PackagePricing = {
      dayPriceMap: new Map(),
      memberIds: new Set([1]),
      priceMap: new Map(),
      quantityMap: new Map([[1, 1]]),
    };
    expect(packageBundleMismatch(solo, [item(1, 0)], new Set())).toBe(true);
  });
});
