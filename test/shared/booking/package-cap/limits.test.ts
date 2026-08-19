import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#booking/build-tree.ts";
import type { TicketListing } from "#booking/model.ts";
import {
  packageBundleLimit,
  packageChildTicketLimits,
  packageLimitInfo,
  pagePackageBundleLimit,
} from "#booking/package-cap.ts";
import {
  packageTree,
  tl,
  treePackage,
} from "#test-utils/package-cap-fixtures.ts";

// PARENT_CHILD_GROUP_UNITS is 2, so a pool of 5 spots fits floor(5/2)=2
// tickets — used across the group-sharing tests below.
const withGroup9Pool5 = (
  groupIdsByListingId: ReadonlyMap<number, number[]>,
  children: readonly TicketListing[],
) =>
  packageLimitInfo(
    [tl(1, 100)],
    new Map([[1, children]]),
    new Map([[9, 5]]),
    groupIdsByListingId,
  );

// One package member (id 1, capacity 100) needing 2 per package, with `children`
// as its sole child set and no group sharing — the shape the sole-child pooling
// tests share, differing only in the children and the expected bundle limit.
const soleMemberBundleLimit = (children: readonly TicketListing[]): number =>
  packageBundleLimit(
    packageTree(new Map([[1, 2]])),
    packageLimitInfo(
      [tl(1, 100)],
      new Map([[1, children]]),
      new Map(),
      new Map(),
    ),
  );

describe("packageChildTicketLimits", () => {
  test("omits members that have no children entry", () => {
    const ctx = packageLimitInfo([tl(1, 10)], new Map(), new Map(), new Map());
    expect(packageChildTicketLimits(ctx)).toEqual(new Map());
  });

  test("omits members whose children array is empty", () => {
    const ctx = packageLimitInfo(
      [tl(1, 10)],
      new Map([[1, []]]),
      new Map(),
      new Map(),
    );
    expect(packageChildTicketLimits(ctx)).toEqual(new Map());
  });

  test("sums each bookable child's own limit when there's no group sharing", () => {
    const ctx = packageLimitInfo(
      [tl(1, 100)],
      new Map([[1, [tl(2, 3), tl(3, 4)]]]),
      new Map(),
      new Map(),
    );
    expect(packageChildTicketLimits(ctx)).toEqual(new Map([[1, 7]]));
  });

  test("excludes a non-bookable child from the sum", () => {
    const closedChild = { ...tl(3, 4), isClosed: true };
    const ctx = packageLimitInfo(
      [tl(1, 100)],
      new Map([[1, [tl(2, 3), closedChild]]]),
      new Map(),
      new Map(),
    );
    expect(packageChildTicketLimits(ctx)).toEqual(new Map([[1, 3]]));
  });

  test("caps children sharing a capped group, whether or not the parent shares it too", () => {
    const children = [tl(2, 100), tl(3, 100)];
    for (const [label, groupIdsByListingId, expected] of [
      [
        "parent shares the group: a parentGroup pool, divided by PARENT_CHILD_GROUP_UNITS",
        new Map([
          [1, [9]],
          [2, [9]],
          [3, [9]],
        ]),
        2,
      ],
      [
        "parent doesn't share the group: a childGroup pool, not divided",
        new Map([
          [2, [9]],
          [3, [9]],
        ]),
        5,
      ],
    ] as const) {
      const ctx = withGroup9Pool5(groupIdsByListingId, children);
      expect(packageChildTicketLimits(ctx), label).toEqual(
        new Map([[1, expected]]),
      );
    }
  });

  test("caps by the pooled limit even with only one parent-group child", () => {
    // Regression: the "no parent-group children" short-circuit checks
    // shared.length === 0, not just falsiness — with exactly one such
    // child, the real pooled computation must still run.
    const ctx = withGroup9Pool5(
      new Map([
        [1, [9]],
        [2, [9]],
      ]),
      [tl(2, 100)],
    );
    expect(packageChildTicketLimits(ctx)).toEqual(new Map([[1, 2]]));
  });

  test("picks the smallest-remaining group when a child belongs to several, regardless of iteration order", () => {
    const groupRemainingByGroupIdAscending = new Map([
      [9, 3],
      [10, 50],
    ]);
    const groupRemainingByGroupIdDescending = new Map([
      [10, 50],
      [9, 3],
    ]);
    for (const [groupRemainingByGroupId, groupIdsByListingId] of [
      [groupRemainingByGroupIdAscending, new Map([[2, [9, 10]]])],
      [groupRemainingByGroupIdDescending, new Map([[2, [10, 9]]])],
    ] as const) {
      const ctx = packageLimitInfo(
        [tl(1, 100)],
        new Map([[1, [tl(2, 100)]]]),
        groupRemainingByGroupId,
        groupIdsByListingId,
      );
      // Group 9 (remaining 3) is smaller than group 10 (remaining 50), so
      // it's the binding pool regardless of which order the maps list them in.
      expect(packageChildTicketLimits(ctx)).toEqual(new Map([[1, 3]]));
    }
  });

  test("is empty when childrenByParentId is undefined", () => {
    const ctx = packageLimitInfo([tl(1, 100)], undefined, new Map(), new Map());
    expect(packageChildTicketLimits(ctx)).toEqual(new Map());
  });
});

describe("packageBundleLimit", () => {
  test("is limited by the package's own quantity when there are no children", () => {
    const tree = packageTree(new Map([[1, 1]]));
    const ctx = packageLimitInfo([tl(1, 10)], new Map(), new Map(), new Map());
    expect(packageBundleLimit(tree, ctx)).toBe(10);
  });

  test("a sole non-daily child constrains the bundle limit via its own ticket pool", () => {
    // Each package needs 2 of this member, and its sole child can only
    // supply 5 tickets total, so floor(5/2)=2 packages — tighter than the
    // package's own quantity limit (floor(100/2)=50).
    expect(soleMemberBundleLimit([tl(2, 5)])).toBe(2);
  });

  test("a sole daily child is not constrained by the per-package ticket pool", () => {
    // Same fixture as the non-daily case above (child limit 5, packageQty
    // 2, which would floor to 2), but a daily child's own limit is already
    // governed by the parent's capacity elsewhere — it must not also be
    // pooled here, so the bundle limit falls back to the package's own
    // quantity limit (floor(100/2)=50).
    expect(soleMemberBundleLimit([tl(2, 5, { listing_type: "daily" })])).toBe(
      50,
    );
  });

  test("does not apply single-child ticket pooling when a member has more than one child", () => {
    // Two children (not a sole child) with no group sharing: the package's
    // own quantity limit already incorporates their summed own-limits via
    // packageChildTicketLimits, so the additional single-child pool must
    // not also apply (which would wrongly treat the first child as sole).
    expect(soleMemberBundleLimit([tl(2, 3), tl(3, 3)])).toBe(3);
  });

  test("pools a shared capped group's capacity across different package members, not per-member", () => {
    // Two separate package members each have a sole child in the SAME
    // capped group (pool of 3). Computed per-member, each would see the
    // full pool of 3 in isolation — but together they draw from one
    // shared pool of 3, one package-set each, so only 1 bundle fits.
    const tree = packageTree(
      new Map([
        [1, 1],
        [4, 1],
      ]),
    );
    const ctx = packageLimitInfo(
      [tl(1, 100), tl(4, 100)],
      new Map([
        [1, [tl(10, 100)]],
        [4, [tl(11, 100)]],
      ]),
      new Map([[9, 3]]),
      new Map([
        [10, [9]],
        [11, [9]],
      ]),
    );
    expect(packageBundleLimit(tree, ctx)).toBe(1);
  });

  test("pools a shared child's own stock across different package members needing the same child", () => {
    // Two separate package members each require the SAME sole child
    // listing (id 20, stock of 3). Computed per-member, each would see the
    // full stock of 3 in isolation — but together each package-set from
    // either member consumes one of the same 3 physical tickets, so only
    // floor(3/2)=1 combined round fits.
    const tree = packageTree(
      new Map([
        [1, 1],
        [4, 1],
      ]),
    );
    const sharedChild = tl(20, 3);
    const ctx = packageLimitInfo(
      [tl(1, 100), tl(4, 100)],
      new Map([
        [1, [sharedChild]],
        [4, [sharedChild]],
      ]),
      new Map(),
      new Map(),
    );
    expect(packageBundleLimit(tree, ctx)).toBe(1);
  });

  test("blocks a member whose only child is non-bookable, unlike a member with no children at all", () => {
    // A required child that's entirely unavailable right now (inactive)
    // is NOT the same as no child requirement — it must block the package
    // (0 available), not silently fall back to the member's own capacity.
    const tree = packageTree(new Map([[1, 1]]));
    const inactiveChild = tl(2, 100, { active: false });
    const ctx = packageLimitInfo(
      [tl(1, 10)],
      new Map([[1, [inactiveChild]]]),
      new Map(),
      new Map(),
    );
    expect(packageBundleLimit(tree, ctx)).toBe(0);
  });
});

describe("pagePackageBundleLimit", () => {
  test("judges one package's bundle limit on a page selling several things", () => {
    // Package 5 needs 2 of listing 1 (7 left → 3 bundles); package 6 and the
    // standalone listing 3 must not leak into that judgement.
    const tree = buildBookingTree({
      listings: [tl(1, 7), tl(2, 1), tl(3, 1)],
      packages: [
        treePackage(5, [1], { quantities: new Map([[1, 2]]) }),
        treePackage(6, [2]),
      ],
      slugs: ["pkg5s", "pkg6s", "cd34e"],
    });
    const pkg = treePackage(5, [1], { quantities: new Map([[1, 2]]) });
    const page = packageLimitInfo(
      [tl(1, 7), tl(2, 1), tl(3, 1)],
      undefined,
      new Map(),
      new Map(),
    );
    expect(pagePackageBundleLimit(tree, pkg, page)).toBe(3);
  });

  test("a package with no member node on the page sells nothing", () => {
    // Every member of package 5 was dropped from the page (e.g. as another
    // listing's child), so no member node exists — the limit must read 0,
    // never Math.min()'s empty-list Infinity.
    const tree = buildBookingTree({
      listings: [tl(3, 5)],
      packages: [treePackage(5, [])],
      slugs: ["cd34e"],
    });
    expect(
      pagePackageBundleLimit(
        tree,
        treePackage(5, []),
        packageLimitInfo([tl(3, 5)], undefined, new Map(), new Map()),
      ),
    ).toBe(0);
  });
});
