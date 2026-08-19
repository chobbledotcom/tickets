import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#booking/build-tree.ts";
import { buildTicketListing } from "#booking/model.ts";
import {
  effectivePrice,
  type PriceRuleInputs,
  packageBundleTotal,
  packageMemberPriceRule,
  priceRuleByListingId,
  selectPriceRule,
} from "#booking/price-tree.ts";
import type { PriceRule } from "#booking/tree.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { treePackage } from "#test-utils/package-cap-fixtures.ts";
import type { ListingWithCount } from "#types";

/** A raw listing (id 7 by default) for direct effectivePrice calls. */
const listing = (over: Partial<ListingWithCount> = {}): ListingWithCount =>
  testListingWithCount({ id: 7, ...over });

/** A resolved cart line for buildBookingTree inputs. */
const resolved = (over: Partial<ListingWithCount> = {}) =>
  buildTicketListing(testListingWithCount(over), false, undefined);

describe("effectivePrice", () => {
  test("OVERRIDE returns the package amount, including an explicit free 0", () => {
    expect(
      effectivePrice(
        { amountMinor: 1200, kind: "OVERRIDE" },
        listing(),
        new Map(),
        1,
      ),
    ).toBe(1200);
    expect(
      effectivePrice(
        { amountMinor: 0, kind: "OVERRIDE" },
        listing(),
        new Map(),
        1,
      ),
    ).toBe(0);
  });

  test("PAY_MORE returns the buyer's custom price, honouring a genuine 0", () => {
    const rule: PriceRule = { kind: "PAY_MORE", maxMinor: 5000, minMinor: 0 };
    expect(
      effectivePrice(
        rule,
        listing({ unit_price: 1000 }),
        new Map([[7, 2000]]),
        1,
      ),
    ).toBe(2000);
    // A submitted 0 (a free pay-more booking) is honoured, not replaced by unit_price.
    expect(
      effectivePrice(rule, listing({ unit_price: 1000 }), new Map([[7, 0]]), 1),
    ).toBe(0);
    // No submitted price falls back to the unit price.
    expect(
      effectivePrice(rule, listing({ unit_price: 1000 }), new Map(), 1),
    ).toBe(1000);
  });

  test("DAY_PRICE returns the day-count price, or 0 for an unoffered count", () => {
    const l = listing({
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 3,
    });
    expect(effectivePrice({ kind: "DAY_PRICE" }, l, new Map(), 2)).toBe(1800);
    // A 3-day span is within duration_days but has no configured price → 0.
    expect(effectivePrice({ kind: "DAY_PRICE" }, l, new Map(), 3)).toBe(0);
  });

  test("DAY_PRICE consults a package's per-day override before the listing's own price", () => {
    const l = listing({
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
    });
    const rule: PriceRule = {
      kind: "DAY_PRICE",
      overrides: new Map([[2, 1500]]),
    };
    // The overridden span charges the package's price, including a free 0…
    expect(effectivePrice(rule, l, new Map(), 2)).toBe(1500);
    expect(
      effectivePrice(
        { kind: "DAY_PRICE", overrides: new Map([[2, 0]]) },
        l,
        new Map(),
        2,
      ),
    ).toBe(0);
    // …while an un-overridden span keeps the listing's own entered day price.
    expect(effectivePrice(rule, l, new Map(), 1)).toBe(1000);
  });

  test("BASE uses the unit price, or a seeded custom price (a signed QR override)", () => {
    expect(
      effectivePrice(
        { kind: "BASE" },
        listing({ unit_price: 500 }),
        new Map(),
        1,
      ),
    ).toBe(500);
    // A fixed-price listing carrying a QR-token override reads it from customPrices.
    expect(
      effectivePrice(
        { kind: "BASE" },
        listing({ unit_price: 500 }),
        new Map([[7, 1500]]),
        1,
      ),
    ).toBe(1500);
  });
});

describe("selectPriceRule", () => {
  /** A listing that offers none of the higher tiers by default. */
  const inputs = (over: Partial<PriceRuleInputs> = {}): PriceRuleInputs => ({
    customisableDays: false,
    dayOverrides: undefined,
    overrideMinor: undefined,
    ...over,
  });

  test("BASE is the fallback when no higher tier applies", () => {
    expect(selectPriceRule(inputs())).toEqual({ kind: "BASE" });
  });

  test("PAY_MORE wins over DAY_PRICE and BASE, carrying its bounds", () => {
    expect(
      selectPriceRule(
        inputs({
          customisableDays: true,
          payMore: { maxMinor: 5000, minMinor: 100 },
        }),
      ),
    ).toEqual({ kind: "PAY_MORE", maxMinor: 5000, minMinor: 100 });
  });

  test("DAY_PRICE wins over BASE and carries its per-day overrides", () => {
    const dayOverrides = new Map([[2, 1500]]);
    expect(
      selectPriceRule(inputs({ customisableDays: true, dayOverrides })),
    ).toEqual({ kind: "DAY_PRICE", overrides: dayOverrides });
  });

  test("OVERRIDE outranks every other tier, carrying its amount (incl. free 0)", () => {
    // Every lower tier is also offered; the flat override must still win.
    const contested = inputs({
      customisableDays: true,
      dayOverrides: new Map([[1, 999]]),
      payMore: { maxMinor: 5000, minMinor: 100 },
    });
    expect(selectPriceRule({ ...contested, overrideMinor: 1200 })).toEqual({
      amountMinor: 1200,
      kind: "OVERRIDE",
    });
    expect(selectPriceRule({ ...contested, overrideMinor: 0 })).toEqual({
      amountMinor: 0,
      kind: "OVERRIDE",
    });
  });
});

describe("packageMemberPriceRule", () => {
  test("never yields PAY_MORE — a member is never pay-what-you-want", () => {
    // Even though the shared precedence has a PAY_MORE tier, this member-pricing
    // entry omits pay-more info, so a customisable member falls to DAY_PRICE.
    expect(packageMemberPriceRule(undefined, undefined, true)).toEqual({
      kind: "DAY_PRICE",
      overrides: undefined,
    });
  });

  test("a flat override outranks the day/base price", () => {
    expect(packageMemberPriceRule(1200, new Map([[1, 999]]), true)).toEqual({
      amountMinor: 1200,
      kind: "OVERRIDE",
    });
  });

  test("a non-member, non-customisable line falls through to BASE", () => {
    expect(packageMemberPriceRule(undefined, undefined, false)).toEqual({
      kind: "BASE",
    });
  });
});

describe("packageBundleTotal", () => {
  /** A package tree carrying one child (id 9, unit 300) under member 5; the
   * caller supplies the members and their package pricing. */
  const bundleTree = (
    over: Pick<Parameters<typeof buildBookingTree>[0], "listings" | "packages">,
  ) =>
    buildBookingTree({
      childrenByParentId: new Map([
        [5, [resolved({ id: 9, unit_price: 300 })]],
      ]),
      slugs: ["pkg"],
      ...over,
    });

  test("sums each member's unit + cheapest bookable child, × its fixed quantity", () => {
    const tree = bundleTree({
      listings: [resolved({ id: 5 }), resolved({ id: 6, unit_price: 500 })],
      packages: [
        treePackage(3, [5, 6], {
          prices: new Map([[5, 1000]]),
          quantities: new Map([[5, 2]]),
        }),
      ],
    });
    // Member 5: (override 1000 + child 300) × fixed 2 = 2600.
    // Member 6: (base 500 + no child 0) × fixed 1 = 500.
    expect(packageBundleTotal(tree, 1, new Set([9]))).toBe(3100);
  });

  test("a child that is not bookable adds nothing to the minimum charge", () => {
    const tree = bundleTree({
      listings: [resolved({ id: 5, unit_price: 1000 })],
      packages: [treePackage(3, [5])],
    });
    // Child 9 is outside the bookable set → filtered out → just the member's 1000.
    expect(packageBundleTotal(tree, 1, new Set())).toBe(1000);
  });
});

describe("priceRuleByListingId", () => {
  test("maps each node's rule — a parent and its child both appear", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([
        [
          4,
          [
            resolved({
              can_pay_more: true,
              id: 9,
              max_price: 5000,
              unit_price: 100,
            }),
          ],
        ],
      ]),
      listings: [resolved({ id: 4 })],
      slugs: ["p"],
    });
    const map = priceRuleByListingId(tree);
    expect(map.get(4)).toEqual({ kind: "BASE" });
    expect(map.get(9)).toEqual({
      kind: "PAY_MORE",
      maxMinor: 5000,
      minMinor: 100,
    });
  });

  test("a top-level node's rule wins over a same-listing child's rule", () => {
    // Package member 5 carries an OVERRIDE and is ALSO a child of member 6 (base).
    // The member line must keep its override; the child copy must not shadow it.
    const tree = buildBookingTree({
      childrenByParentId: new Map([[6, [resolved({ id: 5 })]]]),
      listings: [resolved({ id: 5 }), resolved({ id: 6 })],
      packages: [treePackage(3, [5, 6], { prices: new Map([[5, 1200]]) })],
      slugs: ["pkg"],
    });
    expect(priceRuleByListingId(tree).get(5)).toEqual({
      amountMinor: 1200,
      kind: "OVERRIDE",
    });
  });

  test("a customisable member's DAY_PRICE rule carries its per-day package overrides", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({
          customisable_days: true,
          day_prices: { 1: 1000, 2: 1800 },
          duration_days: 2,
          id: 5,
          listing_type: "daily",
        }),
      ],
      packages: [
        treePackage(3, [5], {
          dayPrices: new Map([[5, new Map([[2, 1500]])]]),
        }),
      ],
      slugs: ["pkg"],
    });
    expect(priceRuleByListingId(tree).get(5)).toEqual({
      kind: "DAY_PRICE",
      overrides: new Map([[2, 1500]]),
    });
  });
});
