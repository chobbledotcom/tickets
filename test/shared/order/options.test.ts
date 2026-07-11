/**
 * The order selection model's option builders — the pure `listingOption` /
 * `packageOption` shapes and their key helpers. These feed the availability
 * evaluator (tested in order-evaluate.test.ts); this file locks their own
 * data-in/data-out contract directly: the wire keys, the "needs a date" rule,
 * and the per-listing unit counts a single selection books.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  listingOption,
  listingOptionKey,
  packageOption,
  packageOptionKey,
} from "#shared/order/options.ts";

describe("order > options", () => {
  describe("key helpers", () => {
    test("listingOptionKey namespaces a listing id", () => {
      expect(listingOptionKey(5)).toBe("listing:5");
    });

    test("packageOptionKey namespaces a group id", () => {
      expect(packageOptionKey(3)).toBe("package:3");
    });
  });

  describe("listingOption", () => {
    const standard = { id: 5, listing_type: "standard", name: "Workshop" };

    test("books one unit of its own listing under the listing key", () => {
      const option = listingOption(standard, true);
      expect(option.key).toBe("listing:5");
      expect(option.name).toBe("Workshop");
      expect([...option.unitsByListingId]).toEqual([[5, 1]]);
    });

    test("a standard listing does not need a date", () => {
      expect(listingOption(standard, true).needsDate).toBe(false);
    });

    test("a daily listing needs a date", () => {
      const daily = { id: 7, listing_type: "daily", name: "Day Pass" };
      expect(listingOption(daily, true).needsDate).toBe(true);
    });

    test("carries the caller's bookable-alone verdict through unchanged", () => {
      expect(listingOption(standard, true).bookableAlone).toBe(true);
      expect(listingOption(standard, false).bookableAlone).toBe(false);
    });
  });

  describe("packageOption", () => {
    const group = { id: 3, name: "Weekend Bundle" };
    const members = [
      { id: 10, listing_type: "standard" },
      { id: 11, listing_type: "standard" },
    ];

    test("books each member at its per-package quantity under the package key", () => {
      const option = packageOption(
        group,
        members,
        new Map([
          [10, 2],
          [11, 3],
        ]),
        true,
      );
      expect(option.key).toBe("package:3");
      expect(option.name).toBe("Weekend Bundle");
      expect([...option.unitsByListingId]).toEqual([
        [10, 2],
        [11, 3],
      ]);
    });

    test("a member without a listed quantity defaults to one unit", () => {
      const option = packageOption(group, members, new Map([[10, 2]]), true);
      // Member 11 is absent from the quantities map, so it falls back to 1.
      expect([...option.unitsByListingId]).toEqual([
        [10, 2],
        [11, 1],
      ]);
    });

    test("keeps an explicit zero quantity instead of defaulting it to one", () => {
      const option = packageOption(
        group,
        members,
        new Map([
          [10, 0],
          [11, 4],
        ]),
        true,
      );
      // A listed 0 is a real per-package quantity — distinct from an absent
      // member, which would fall back to 1.
      expect([...option.unitsByListingId]).toEqual([
        [10, 0],
        [11, 4],
      ]);
    });

    test("needs a date when any member is a daily listing", () => {
      const withDaily = [
        { id: 10, listing_type: "standard" },
        { id: 11, listing_type: "daily" },
      ];
      expect(packageOption(group, withDaily, new Map(), true).needsDate).toBe(
        true,
      );
    });

    test("does not need a date when every member is non-daily", () => {
      expect(packageOption(group, members, new Map(), true).needsDate).toBe(
        false,
      );
    });

    test("carries the caller's bookable-alone verdict through unchanged", () => {
      expect(
        packageOption(group, members, new Map(), false).bookableAlone,
      ).toBe(false);
      expect(packageOption(group, members, new Map(), true).bookableAlone).toBe(
        true,
      );
    });
  });
});
