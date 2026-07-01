import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import fc from "fast-check";
import { t } from "#i18n";
import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
import {
  childSelectableForSpan,
  type FoldBase,
  foldBookingTree,
  foldChild,
  resolveChildSelections,
  resolvedByNodeKey,
} from "#shared/booking/fold-tree.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { FormParams } from "#shared/form-data.ts";
import type { Holiday, ListingWithCount } from "#shared/types.ts";
import { buildTicketListing, type TicketListing } from "#templates/public.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

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
  selectedListingIds: new Set<number>(),
});

/** Mirror the production adapter's steps, purely (no DB; holidays default none):
 * build the tree, resolve each node's availability, run the walk. */
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

/** Fold a single standalone parent (id 1, quantity `parentQty`) over one child
 * (id 9) built from `childOver`, given the posted fields. */
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

/** Assert a fold failed with exactly `error`. */
const expectFoldError = (
  fold: ReturnType<typeof foldBookingTree>,
  error: string,
): void => {
  expect(fold.ok).toBe(false);
  if (fold.ok) return;
  expect(fold.error).toBe(error);
};

/** A pay-more child priced £10–£50 (minor units). */
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
    expect(fold.selectedListingIds.has(1)).toBe(true);
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

  test("folds a posted child quantity into one allocation and an ordinary line", () => {
    const fold = foldOneChild({ max_quantity: 9 }, { child_qty_1_9: "2" }, 2);
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
    expect(fold.allocations).toEqual([{ childId: 9, parentId: 1, qty: 2 }]);
    expect(fold.quantities.get(9)).toBe(2);
    expect(fold.selectedListingIds.has(9)).toBe(true);
    expect(fold.listings.map((l) => l.listing.id)).toContain(9);
  });

  test("auto-fills a sole bookable child to the whole parent quantity", () => {
    const fold = foldOneChild({ max_quantity: 9 }, {}, 3);
    expect(fold.ok).toBe(true);
    if (!fold.ok) return;
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
    // Summed into a single line, not duplicated.
    expect(fold.listings.filter((l) => l.listing.id === 9)).toHaveLength(1);
  });

  test("a parent whose only child is sold out is rejected", () => {
    expectFoldError(
      foldOneChild({ attendee_count: 1, max_attendees: 1 }, {}, 1),
      SOLD_OUT,
    );
  });

  test("a daily child with no chosen date is not bookable (sold out)", () => {
    // childSelectableForSpan passes (active, priced, duration matches) but
    // childDateOk is false for a daily listing with no date — the `&&` right arm.
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
    // Form prices are in major units: "20" → 2000 minor, within [1000, 5000].
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
    // "5" → 500 minor, below the 1000 minimum → rejected.
    const fold = foldOneChild(
      PAY_MORE_CHILD,
      { child_price_1_9: "5", child_qty_1_9: "1" },
      1,
    );
    expect(fold.ok).toBe(false);
  });

  test("rejects a child folded above its own max-purchasable", () => {
    // Default max_quantity 1 → maxPurchasable 1; two units under one parent
    // exceeds the cap, so the walk surfaces foldChild's capacity error.
    expect(foldOneChild({}, { child_qty_1_9: "2" }, 2).ok).toBe(false);
  });
});

describe("childSelectableForSpan", () => {
  test("with no span applies only the date/span-independent disqualifiers", () => {
    expect(childSelectableForSpan(tl(1), null)).toBe(true);
    // Sold out fails the span-independent check regardless of span.
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
    // No price configured for a 2-day span → not selectable for that span.
    expect(childSelectableForSpan(child, 2)).toBe(false);
  });

  test("with a span rejects a fixed daily child whose duration differs", () => {
    const daily = tl(1, { duration_days: 2, listing_type: "daily" });
    expect(childSelectableForSpan(daily, 2)).toBe(true);
    // A 2-day fixed daily child can't serve a 1-day span (duration mismatch).
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
});

describe("foldChild — summing, capacity, duration, price", () => {
  test("a daily child skips the date-less max-purchasable cap", () => {
    const state = freshState();
    // max_quantity 1 → maxPurchasable 1; a standard child would reject qty 5, a
    // daily child must not (its per-date cap is enforced by checkAvailability).
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
    // Same duration again: still fine.
    expect(foldChild(state, cust, 1, 2, 2, undefined)).toBeNull();
    // The shared duration is *set* to the value, not accumulated across folds.
    expect(state.customisableDuration).toBe(2);
    // A different duration can't be represented by the single dayCount.
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
    // Same price on another fold: no conflict.
    expect(foldChild(state, child, 1, 1, 2, 2000)).toBeNull();
    expect(state.customPrices.get(9)).toBe(2000);
    // A different price for the same child id is a mismatch.
    expect(foldChild(state, child, 1, 1, 3, 2500)).toBe(
      t("public.ticket.child_price_mismatch", { name: "Test Listing" }),
    );
  });
});

// Pure (no DB) property tests over the per-parent fold algebra. Mutation testing
// confirmed the example-based fold suite is tight; these explore the input space
// the examples can't enumerate, pinning the core invariants directly.
describe("fold selection algebra (property-based)", () => {
  const PARENT_ID = 100;

  /** A bookable, high-capacity standard listing wrapped as a cart line. */
  const line = (
    id: number,
    over: Partial<ListingWithCount> = {},
  ): TicketListing =>
    tl(id, {
      max_attendees: 1000,
      max_quantity: 1000,
      name: `L${id}`,
      ...over,
    });

  test("resolveChildSelections accepts iff the chosen quantities sum to exactly the parent quantity", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 10, min: 1 }),
        fc.array(fc.integer({ max: 12, min: 0 }), {
          maxLength: 4,
          minLength: 1,
        }),
        (parentQty, qtys) => {
          const parent = line(PARENT_ID);
          const children = qtys.map((_, i) => line(i + 1));
          const record: Record<string, string> = {};
          qtys.forEach((q, i) => {
            record[`child_qty_${PARENT_ID}_${i + 1}`] = String(q);
          });
          const result = resolveChildSelections(
            parent,
            children,
            parentQty,
            formFrom(record),
          );
          const total = qtys.reduce((a, b) => a + b, 0);
          // A sole child with nothing submitted auto-fills the whole parent qty.
          const autoSelect = total === 0 && children.length === 1;
          if (total === parentQty || autoSelect) {
            if (!Array.isArray(result)) return false;
            const sum = result.reduce((acc, s) => acc + s.qty, 0);
            return sum === parentQty && result.every((s) => s.qty > 0);
          }
          return !Array.isArray(result);
        },
      ),
    );
  });

  test("resolveChildSelections rejects any positive quantity on a child not bookable under the parent", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 10, min: 1 }),
        fc.integer({ max: 50, min: 1 }),
        fc.integer({ max: 5, min: 1 }),
        (parentQty, strangerOffset, strangerQty) => {
          const parent = line(PARENT_ID);
          const child = line(1);
          const strangerId = 1000 + strangerOffset;
          const record = {
            [`child_qty_${PARENT_ID}_1`]: String(parentQty),
            [`child_qty_${PARENT_ID}_${strangerId}`]: String(strangerQty),
          };
          const result = resolveChildSelections(
            parent,
            [child],
            parentQty,
            formFrom(record),
          );
          return !Array.isArray(result);
        },
      ),
    );
  });

  test("resolveChildSelections parses child quantities strictly, not via parseInt truncation", () => {
    const parent = line(PARENT_ID);
    const result = resolveChildSelections(
      parent,
      [line(1), line(2), line(3)],
      2,
      formFrom({
        [`child_qty_${PARENT_ID}_1`]: "2",
        [`child_qty_${PARENT_ID}_2`]: "2.9",
        [`child_qty_${PARENT_ID}_3`]: "1abc",
      }),
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result.map((s) => s.child.listing.id)).toEqual([1]);
      expect(result.reduce((acc, s) => acc + s.qty, 0)).toBe(2);
    }
  });

  test("foldChild sums across folds and rejects (never clamps) above max-purchasable", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 20, min: 1 }),
        fc.array(fc.integer({ max: 8, min: 1 }), {
          maxLength: 6,
          minLength: 1,
        }),
        (max, qtys) => {
          const child = line(1, { max_attendees: max, max_quantity: max });
          const state = freshState();
          let running = 0;
          for (const q of qtys) {
            const error = foldChild(state, child, q, 1, PARENT_ID, undefined);
            running += q;
            if (running <= max) {
              if (error !== null) return false;
              if (state.quantities.get(1) !== running) return false;
            } else {
              return error !== null && state.quantities.get(1) !== running;
            }
          }
          return true;
        },
      ),
    );
  });
});
