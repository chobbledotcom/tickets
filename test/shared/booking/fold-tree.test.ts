import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type BuildTreeInput, buildBookingTree } from "#booking/build-tree.ts";
import {
  childSelectableForSpan,
  type FoldBase,
  foldBookingTree,
  foldChild,
  resolveChildSelections,
  resolvedByNodeKey,
} from "#booking/fold-tree.ts";
import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import type { ChildAllocation } from "#db/attendee-types.ts";
import { t } from "#i18n";
import { FormParams } from "#shared/form-data.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { treePackage } from "#test-utils/package-cap-fixtures.ts";
import type { Holiday, ListingWithCount } from "#types";

/** A cart line resolved against availability (the shape the fold reads). */
const tl = (
  id: number,
  over: Partial<ListingWithCount> = {},
  closed = false,
  groupRemaining?: number,
): TicketListing =>
  buildTicketListing(
    testListingWithCount({ id, ...over }),
    closed,
    groupRemaining,
  );

const formFrom = (record: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(record));

const baseOrder = (
  quantities: Map<number, number>,
  over: Partial<FoldBase> = {},
): FoldBase => ({
  customPrices: new Map(),
  date: null,
  dayCount: 1,
  hasCustomisable: false,
  quantities,
  ...over,
});

/** A fresh fold accumulator (the `FoldState` shape the walk threads). */
const freshState = () => ({
  allocations: [] as ChildAllocation[],
  customisableDuration: null as number | null,
  customPrices: new Map<number, number>(),
  listings: [] as TicketListing[],
  quantities: new Map<number, number>(),
});

const foldOf = (
  input: BuildTreeInput,
  form: FormParams,
  base: FoldBase,
  holidays: Holiday[] = [],
) => {
  const tree = buildBookingTree(input);
  const resolved = resolvedByNodeKey(
    input.listings,
    input.childrenByParentId ?? new Map(),
    tree,
  );
  return foldBookingTree(tree, resolved, form, base, holidays);
};

const foldOneChild = (
  childOver: Partial<ListingWithCount>,
  formRecord: Record<string, string>,
  parentQty: number,
  baseOver: Partial<FoldBase> = {},
) =>
  foldOf(
    {
      childrenByParentId: new Map([[1, [tl(9, childOver)]]]),
      listings: [tl(1)],
      slugs: ["p1"],
    },
    formFrom(formRecord),
    baseOrder(new Map([[1, parentQty]]), baseOver),
  );

const expectFoldError = (
  fold: ReturnType<typeof foldBookingTree>,
  error: string,
): void => {
  expect(fold.ok).toBe(false);
  if (fold.ok) return;
  expect(fold.error).toBe(error);
};

function expectFoldOk(
  fold: ReturnType<typeof foldBookingTree>,
): asserts fold is Extract<ReturnType<typeof foldBookingTree>, { ok: true }> {
  expect(fold.ok).toBe(true);
}

const PAY_MORE_CHILD: Partial<ListingWithCount> = {
  can_pay_more: true,
  max_price: 5000,
  max_quantity: 9,
  unit_price: 1000,
};

const SOLD_OUT = t("public.ticket.child_sold_out", { name: "Test Listing" });

describe("foldBookingTree — walking the tree", () => {
  test("no parent with children returns the base order unchanged", () => {
    const fold = foldOf(
      { listings: [tl(1), tl(2)], slugs: ["a"] },
      formFrom({}),
      baseOrder(new Map([[1, 2]])),
    );
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.allocations).toEqual([]);
    expect([...fold.quantities]).toEqual([[1, 2]]);
    expect(fold.listings.map((l) => l.listing.id)).toEqual([1, 2]);
    expect(fold.hasCustomisable).toBe(false);
    expect(fold.dayCount).toBe(1);
  });

  test("a zero-quantity parent ignores its child fields entirely", () => {
    const fold = foldOneChild({ max_quantity: 9 }, { child_qty_1_9: "5" }, 0);
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.allocations).toEqual([]);
    expect(fold.quantities.has(9)).toBe(false);
  });

  test("a parent absent from the submitted quantities does not fold children", () => {
    const fold = foldOneChild({ max_quantity: 9 }, { child_qty_1_9: "1" }, 1, {
      quantities: new Map(),
    });
    expectFoldOk(fold);
    expect(fold.allocations).toEqual([]);
    expect(fold.quantities.has(9)).toBe(false);
  });

  test("folds a posted child quantity into one allocation and an ordinary line", () => {
    const fold = foldOneChild({ max_quantity: 9 }, { child_qty_1_9: "2" }, 2);
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.allocations).toEqual([{ childId: 9, parentId: 1, qty: 2 }]);
    expect(fold.quantities.get(9)).toBe(2);
    expect(fold.listings.map((l) => l.listing.id)).toContain(9);
  });

  test("a parent booked through two paths folds its children exactly once", () => {
    const fold = foldOf(
      {
        childrenByParentId: new Map([[1, [tl(9, { max_quantity: 9 })]]]),
        listings: [tl(1)],
        packages: [treePackage(3, [1])],
        slugs: ["pkg3s", "p1"],
        standaloneListingIds: new Set([1]),
      },
      formFrom({ child_qty_1_9: "3" }),
      baseOrder(new Map([[1, 3]])),
    );
    expectFoldOk(fold);
    expect(fold.allocations).toEqual([{ childId: 9, parentId: 1, qty: 3 }]);
    expect(fold.listings.filter((info) => info.listing.id === 1)).toHaveLength(
      1,
    );
  });

  test("auto-fills a sole bookable child to the whole parent quantity", () => {
    const fold = foldOneChild({ max_quantity: 9 }, {}, 3);
    expectFoldOk(fold);
    expect(fold.allocations).toEqual([{ childId: 9, parentId: 1, qty: 3 }]);
    expect(fold.quantities.get(9)).toBe(3);
  });

  test("the same child under two parents is two allocations but one summed line", () => {
    const child = tl(9, { max_quantity: 9 });
    const input: BuildTreeInput = {
      childrenByParentId: new Map([
        [1, [child]],
        [2, [child]],
      ]),
      listings: [tl(1), tl(2)],
      slugs: ["p"],
    };
    const fold = foldOf(
      input,
      formFrom({ child_qty_1_9: "1", child_qty_2_9: "1" }),
      baseOrder(
        new Map([
          [1, 1],
          [2, 1],
        ]),
      ),
    );
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.allocations).toHaveLength(2);
    expect(fold.allocations.map((a) => a.parentId).sort()).toEqual([1, 2]);
    expect(fold.quantities.get(9)).toBe(2);
    expect(fold.listings.filter((l) => l.listing.id === 9)).toHaveLength(1);
  });

  test("a parent whose only child is sold out is rejected", () => {
    expectFoldError(
      foldOneChild({ attendee_count: 1, max_attendees: 1 }, {}, 1),
      SOLD_OUT,
    );
  });

  test("a daily child with no chosen date is not bookable (sold out)", () => {
    expectFoldError(
      foldOneChild({ listing_type: "daily", max_quantity: 9 }, {}, 1, {
        date: null,
      }),
      SOLD_OUT,
    );
  });

  test("rejects a positive quantity on a child not bookable under the parent", () => {
    expectFoldError(
      foldOneChild(
        { max_quantity: 9 },
        { child_qty_1_8: "1", child_qty_1_9: "1" },
        1,
      ),
      t("public.ticket.child_required", { name: "Test Listing" }),
    );
  });

  test("propagates a folded customisable child's shared duration", () => {
    const fold = foldOneChild(
      { customisable_days: true, day_prices: { 1: 500 }, max_quantity: 9 },
      { child_qty_1_9: "1" },
      1,
      { dayCount: 1, hasCustomisable: false },
    );
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.hasCustomisable).toBe(true);
    expect(fold.dayCount).toBe(1);
  });

  test("keeps the page's own customisable flag when no child is customisable", () => {
    const fold = foldOneChild({ max_quantity: 9 }, { child_qty_1_9: "1" }, 1, {
      dayCount: 2,
      hasCustomisable: true,
    });
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.hasCustomisable).toBe(true);
    expect(fold.dayCount).toBe(2);
  });

  test("records a chosen pay-more child price", () => {
    const fold = foldOneChild(
      PAY_MORE_CHILD,
      { child_price_1_9: "20", child_qty_1_9: "1" },
      1,
    );
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.customPrices.get(9)).toBe(2000);
  });

  test("rejects an invalid pay-more child price", () => {
    const fold = foldOneChild(
      PAY_MORE_CHILD,
      { child_price_1_9: "5", child_qty_1_9: "1" },
      1,
    );
    expect(fold.ok).toBe(false);
  });

  test("rejects a child folded above its own max-purchasable", () => {
    expect(foldOneChild({}, { child_qty_1_9: "2" }, 2).ok).toBe(false);
  });
});

describe("childSelectableForSpan", () => {
  test("with no span applies only the date/span-independent disqualifiers", () => {
    expect(childSelectableForSpan(tl(1), null)).toBe(true);
    expect(
      childSelectableForSpan(
        tl(1, { attendee_count: 1, max_attendees: 1 }),
        null,
      ),
    ).toBe(false);
  });

  test("with a span rejects a customisable child that can't price it", () => {
    const child = tl(1, {
      customisable_days: true,
      day_prices: { 1: 500 },
      duration_days: 3,
    });
    expect(childSelectableForSpan(child, 1)).toBe(true);
    expect(childSelectableForSpan(child, 2)).toBe(false);
  });

  test("with a span rejects a fixed daily child whose duration differs", () => {
    const daily = tl(1, { duration_days: 2, listing_type: "daily" });
    expect(childSelectableForSpan(daily, 2)).toBe(true);
    expect(childSelectableForSpan(daily, 1)).toBe(false);
  });
});

describe("resolveChildSelections — error counts", () => {
  const parent = tl(100, { name: "P" });

  test("reports the exact shortfall when too few are chosen", () => {
    const result = resolveChildSelections(
      parent,
      [tl(1, { max_quantity: 9 }), tl(2, { max_quantity: 9 })],
      3,
      formFrom({ child_qty_100_1: "1" }),
    );
    expect(result).toEqual({
      error: t("public.ticket.child_too_few", { count: 2, name: "P" }),
    });
  });

  test("reports the exact excess when too many are chosen", () => {
    const result = resolveChildSelections(
      parent,
      [tl(1, { max_quantity: 9 })],
      1,
      formFrom({ child_qty_100_1: "3" }),
    );
    expect(result).toEqual({
      error: t("public.ticket.child_too_many", { count: 2, name: "P" }),
    });
  });

  test("treats malformed child quantities as no selection", () => {
    const result = resolveChildSelections(
      parent,
      [tl(1), tl(2)],
      2,
      formFrom({ child_qty_100_1: "2", child_qty_100_2: "2.9" }),
    );
    if (!Array.isArray(result)) throw new Error("Expected child selections");
    expect(result.map(({ child, qty }) => [child.listing.id, qty])).toEqual([
      [1, 2],
    ]);
  });
});

describe("foldChild — summing, capacity, duration, price", () => {
  test("a daily child skips the date-less max-purchasable cap", () => {
    const state = freshState();
    const daily = tl(9, { listing_type: "daily", max_quantity: 1 });
    expect(foldChild(state, daily, 5, 1, 1, undefined)).toBeNull();
    expect(state.quantities.get(9)).toBe(5);
  });

  test("records a matching duration once and rejects a second distinct one", () => {
    const state = freshState();
    const cust = tl(9, {
      customisable_days: true,
      day_prices: { 1: 100, 2: 200 },
      duration_days: 2,
      max_quantity: 9,
    });
    expect(foldChild(state, cust, 1, 2, 1, undefined)).toBeNull();
    expect(foldChild(state, cust, 1, 2, 2, undefined)).toBeNull();
    expect(state.customisableDuration).toBe(2);
    expect(foldChild(state, cust, 1, 1, 3, undefined)).toBe(
      t("public.ticket.mixed_durations"),
    );
  });

  test("keeps a repeated price but rejects a conflicting one for the same child", () => {
    const state = freshState();
    const child = tl(9, {
      can_pay_more: true,
      max_price: 9000,
      max_quantity: 9,
    });
    expect(foldChild(state, child, 1, 1, 1, 2000)).toBeNull();
    expect(foldChild(state, child, 1, 1, 2, 2000)).toBeNull();
    expect(state.customPrices.get(9)).toBe(2000);
    expect(foldChild(state, child, 1, 1, 3, 2500)).toBe(
      t("public.ticket.child_price_mismatch", { name: "Test Listing" }),
    );
  });
});
