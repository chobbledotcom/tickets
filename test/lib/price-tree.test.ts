import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import {
  effectivePrice,
  priceRuleByListingId,
} from "#shared/booking/price-tree.ts";
import type { PriceRule } from "#shared/booking/tree.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { buildTicketListing } from "#templates/public.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

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
      groupId: 3,
      isPackage: true,
      listings: [resolved({ id: 5 }), resolved({ id: 6 })],
      packagePrices: new Map([[5, 1200]]),
      slugs: ["pkg"],
    });
    expect(priceRuleByListingId(tree).get(5)).toEqual({
      amountMinor: 1200,
      kind: "OVERRIDE",
    });
  });

  test("a customisable member's DAY_PRICE rule carries its per-day package overrides", () => {
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [
        resolved({
          customisable_days: true,
          day_prices: { 1: 1000, 2: 1800 },
          duration_days: 2,
          id: 5,
          listing_type: "daily",
        }),
      ],
      packageDayPrices: new Map([[5, new Map([[2, 1500]])]]),
      slugs: ["pkg"],
    });
    expect(priceRuleByListingId(tree).get(5)).toEqual({
      kind: "DAY_PRICE",
      overrides: new Map([[2, 1500]]),
    });
  });
});
