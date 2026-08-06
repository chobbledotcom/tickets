import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  anyPackageBundleMismatch,
  expectedItemPrice,
  packageBundleMismatch,
} from "#routes/api/payment-processing/package-pricing.ts";
import type { PricedListing } from "#shared/booking/price-tree.ts";
import type { RegistrationPackagePricing as PackagePricing } from "#shared/registration-package-facts.ts";

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

/** A fixed-price listing row: priced by unit_price alone. */
const fixedListing = (id: number, unitPrice: number): PricedListing => ({
  customisable_days: false,
  day_prices: {},
  duration_days: 1,
  id,
  unit_price: unitPrice,
});

/** A customisable listing row priced by its own entered day prices. */
const dayListing = (
  id: number,
  dayPrices: Record<number, number>,
): PricedListing => ({
  customisable_days: true,
  day_prices: dayPrices,
  duration_days: 3,
  id,
  unit_price: 0,
});

/** The checkout's non-customisable default: day count 1, no day pricing. */
const price = (
  p: PackagePricing | undefined,
  lineGroupId: number | undefined,
  folded: Set<number>,
  line: { e: number; p: number; q: number },
  base: number,
) =>
  expectedItemPrice(
    p,
    lineGroupId,
    folded,
    line,
    fixedListing(line.e, base),
    1,
  );

describe("expectedItemPrice (package revalidation)", () => {
  test("a non-package booking uses the base price", () => {
    expect(price(undefined, undefined, new Set(), item(1), 5000)).toBe(5000);
  });

  test("a folded child keeps the base price even when it's a member", () => {
    expect(price(pkg, 3, new Set([1]), item(1), 5000)).toBe(5000);
  });

  test("a member with a non-zero override is priced at override × qty", () => {
    expect(price(pkg, 3, new Set(), item(1, 3), 5000)).toBe(4500);
  });

  test("a member with no override uses the base price for every unit", () => {
    expect(price(pkg, 3, new Set(), item(2, 3), 5000)).toBe(15000);
  });

  test("an explicit free override stays free for every unit", () => {
    const free = { ...pkg, priceMap: new Map([[1, 0]]) };
    expect(price(free, 3, new Set(), item(1, 3), 5000)).toBe(0);
  });

  test("a package line that is no longer a member fails closed", () => {
    expect(price(pkg, 3, new Set(), item(9), 5000)).toBeNull();
  });

  test("a package whose group was deleted/unflagged fails closed", () => {
    expect(price(undefined, 3, new Set(), item(1), 5000)).toBeNull();
  });

  test("a customisable member's per-day override prices override × qty", () => {
    expect(
      expectedItemPrice(
        pkg,
        3,
        new Set(),
        item(2, 3),
        dayListing(2, { 2: 5000 }),
        2,
      ),
    ).toBe(2100);
  });

  test("a customisable member without an override for the chosen span keeps its own day price", () => {
    // The package's day override covers span 2 only; span 3 falls through to
    // the listing's own entered 3-day price — the same DAY_PRICE fallback the
    // checkout evaluated.
    expect(
      expectedItemPrice(
        pkg,
        3,
        new Set(),
        item(2),
        dayListing(2, { 3: 5000 }),
        3,
      ),
    ).toBe(5000);
  });

  test("a flat override outranks a per-day override, mirroring the checkout", () => {
    const flatAndDay: PackagePricing = {
      ...pkg,
      dayPriceMap: new Map([[1, new Map([[2, 700]])]]),
    };
    expect(
      expectedItemPrice(
        flatAndDay,
        3,
        new Set(),
        item(1),
        dayListing(1, { 2: 5000 }),
        2,
      ),
    ).toBe(1500);
  });

  test("a day override never applies to a non-customisable member", () => {
    expect(
      expectedItemPrice(pkg, 3, new Set(), item(2), fixedListing(2, 5000), 2),
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
    expect(packageBundleMismatch(bundle, [item(1, 2), item(2, 4)])).toBe(false);
  });

  test("a missing member (one added since checkout) is a mismatch", () => {
    expect(packageBundleMismatch(bundle, [item(1, 1)])).toBe(true);
  });

  test("an extra non-member line is a mismatch", () => {
    expect(
      packageBundleMismatch(bundle, [item(1, 1), item(2, 2), item(9, 1)]),
    ).toBe(true);
  });

  test("a non-member line substituted for a member is a mismatch", () => {
    // Same line count as the bundle, but listing 9 stands in for member 2.
    expect(packageBundleMismatch(bundle, [item(1, 1), item(9, 2)])).toBe(true);
  });

  test("a member whose quantity is no longer a whole package count is a mismatch", () => {
    // Member 2 needs ×2 per package, but q=3 is not a multiple of 2.
    expect(packageBundleMismatch(bundle, [item(1, 1), item(2, 3)])).toBe(true);
  });

  test("members implying different package counts is a mismatch", () => {
    // Member 1 ×1 → count 1; member 2 ×4 → count 2.
    expect(packageBundleMismatch(bundle, [item(1, 1), item(2, 4)])).toBe(true);
  });

  test("folded children are excluded from the bundle comparison", () => {
    // The caller passes only the package's top-level lines: it pre-filters
    // folded children (id 9) out, so the remaining lines match the bundle.
    const foldedChildIds = new Set([9]);
    const packageLines = [item(1, 1), item(2, 2), item(9, 5)].filter(
      (line) => !foldedChildIds.has(line.e),
    );
    expect(packageBundleMismatch(bundle, packageLines)).toBe(false);
  });

  test("a member missing from the quantity map defaults to 1 per package", () => {
    const noQty: PackagePricing = {
      dayPriceMap: new Map(),
      memberIds: new Set([1]),
      priceMap: new Map(),
      quantityMap: new Map(),
    };
    // Default ×1, q=2 → count 2 (a whole number), so a lone member matches.
    expect(packageBundleMismatch(noQty, [item(1, 2)])).toBe(false);
  });

  test("a zero-quantity line is a mismatch", () => {
    const solo: PackagePricing = {
      dayPriceMap: new Map(),
      memberIds: new Set([1]),
      priceMap: new Map(),
      quantityMap: new Map([[1, 1]]),
    };
    expect(packageBundleMismatch(solo, [item(1, 0)])).toBe(true);
  });
});

describe("anyPackageBundleMismatch (multi-group revalidation)", () => {
  // Group 10 bundles members 1 & 2 (one each per package); group 20 bundles
  // member 3. Each group is revalidated against only its own tagged lines.
  const groupA: PackagePricing = {
    dayPriceMap: new Map(),
    memberIds: new Set([1, 2]),
    priceMap: new Map(),
    quantityMap: new Map([
      [1, 1],
      [2, 1],
    ]),
  };
  const groupB: PackagePricing = {
    dayPriceMap: new Map(),
    memberIds: new Set([3]),
    priceMap: new Map(),
    quantityMap: new Map([[3, 1]]),
  };
  /** A signed line tagged as a package member of `groupId` (k:"p", r:groupId),
   *  which is how lineGroupId assigns a line to its group. */
  const line = (e: number, groupId: number, q = 1) =>
    ({ e, k: "p", p: 0, q, r: groupId }) as const;

  test("no packages means nothing can have drifted", () => {
    expect(anyPackageBundleMismatch(new Map(), [])).toBe(false);
  });

  test("a single group whose lines still match is not a mismatch", () => {
    expect(
      anyPackageBundleMismatch(new Map([[10, groupA]]), [
        line(1, 10),
        line(2, 10),
      ]),
    ).toBe(false);
  });

  test("a single group missing a member is a mismatch", () => {
    expect(
      anyPackageBundleMismatch(new Map([[10, groupA]]), [line(1, 10)]),
    ).toBe(true);
  });

  test("one drifted group among several fails the whole order", () => {
    // Group 10's lines match, but group 20 has no lines at all → mismatch.
    const pricing = new Map([
      [10, groupA],
      [20, groupB],
    ]);
    expect(anyPackageBundleMismatch(pricing, [line(1, 10), line(2, 10)])).toBe(
      true,
    );
  });

  test("each group is revalidated against only its OWN tagged lines", () => {
    // Interleaved lines for both groups; filtered per group, both bundles match,
    // so mixing another group's lines in must not trip a mismatch.
    const pricing = new Map([
      [10, groupA],
      [20, groupB],
    ]);
    expect(
      anyPackageBundleMismatch(pricing, [
        line(1, 10),
        line(2, 10),
        line(3, 20),
      ]),
    ).toBe(false);
  });
});
