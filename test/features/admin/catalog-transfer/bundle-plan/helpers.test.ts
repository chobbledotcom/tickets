import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bundlePackageMemberError,
  describeFailure,
  edgeListingOfPlan,
  edgeListingOfRow,
  packageMemberRefusals,
  sameMembership,
} from "#routes/admin/catalog-transfer/bundle-plan.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import type { ListingWithCount } from "#types";

/** The minimal ListingInput a plan needs for the pure helpers. */
const planInput = (over: Partial<ListingInput> = {}): ListingInput =>
  ({
    canPayMore: false,
    maxQuantity: 1,
    minQuantity: 1,
    name: "Workshop",
    parentKeys: [],
    ...over,
  }) as ListingInput;

describe("bundle plan helpers", () => {
  test("describeFailure quotes the item and joins its reasons", () => {
    expect(
      describeFailure({
        item: "Act 0",
        reasons: ["first reason", "second reason"],
      }),
    ).toBe('"Act 0": first reason; "Act 0": second reason');
  });

  test("sameMembership accepts equal declarations", () => {
    const one = { dayPrices: { "1": 500 }, packagePrice: 900, quantity: 2 };
    expect(sameMembership(one, { ...one })).toBe(true);
  });

  test("sameMembership refuses a package-price, quantity, or day-price difference", () => {
    const one = {
      dayPrices: { "1": 500, "2": 800 },
      packagePrice: 900,
      quantity: 2,
    };
    expect(sameMembership(one, { ...one, packagePrice: 800 })).toBe(false);
    expect(sameMembership(one, { ...one, quantity: 1 })).toBe(false);
    expect(
      sameMembership(one, { ...one, dayPrices: { "1": 500, "2": 900 } }),
    ).toBe(false);
    // A day-price key one side drops is a difference that matters.
    expect(sameMembership(one, { ...one, dayPrices: { "1": 500 } })).toBe(
      false,
    );
  });

  test("edgeListingOfRow projects the stored row's edge fields", () => {
    const row = {
      assign_built_site: true,
      customisable_days: true,
      day_prices: { "1": 600 },
      duration_days: 2,
      id: 7,
      listing_type: "standard",
      min_quantity: 1,
      months_per_unit: 1,
      name: "Stored",
    } as unknown as ListingWithCount;
    expect(edgeListingOfRow(row)).toEqual({
      assign_built_site: true,
      customisable_days: true,
      day_prices: { "1": 600 },
      duration_days: 2,
      id: 7,
      listing_type: "standard",
      min_quantity: 1,
      months_per_unit: 1,
      name: "Stored",
    });
  });

  test("edgeListingOfPlan carries id 0, because the row does not exist yet", () => {
    const edge = edgeListingOfPlan({ input: planInput(), parentKeys: [] });
    expect(edge.id).toBe(0);
    expect(edge.name).toBe("Workshop");
  });

  test("bundlePackageMemberError is null when nothing blocks the member", () => {
    expect(
      bundlePackageMemberError(
        { input: planInput(), parentKeys: [] },
        undefined,
      ),
    ).toBeNull();
  });

  test("bundlePackageMemberError refuses a parent-referencing member", () => {
    const error = bundlePackageMemberError(
      { input: planInput(), parentKeys: ["workshop"] },
      undefined,
    );
    expect(error).toContain("Workshop");
  });

  test("packageMemberRefusals reports the pick count and the day override", () => {
    const dayFields = {
      customisable_days: true,
      day_prices: { "1": 600 },
      duration_days: 1,
    };
    // A member whose quantity 3 passes the cap of 1, and whose override
    // targets a 2-day booking the member does not offer.
    expect(
      packageMemberRefusals(
        "Act 0",
        { max_quantity: 1, min_quantity: 1 },
        { dayPrices: { "2": 300 }, packagePrice: null, quantity: 3 },
        dayFields,
      ),
    ).toHaveLength(2);
    // Only the day override fails: the quantity sits inside the cap.
    expect(
      packageMemberRefusals(
        "Act 0",
        { max_quantity: 5, min_quantity: 1 },
        { dayPrices: { "2": 300 }, packagePrice: null, quantity: 3 },
        dayFields,
      ),
    ).toHaveLength(1);
    // Nothing fails.
    expect(
      packageMemberRefusals(
        "Act 0",
        { max_quantity: 5, min_quantity: 1 },
        { dayPrices: { "1": 300 }, packagePrice: null, quantity: 3 },
        dayFields,
      ),
    ).toEqual([]);
  });
});
