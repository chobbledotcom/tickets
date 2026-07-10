import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildPagePackage,
  combinedPackageTerms,
  explicitStandaloneIds,
  packageByMemberListingId,
  packageMemberIds,
  soleParentPackageIds,
  stampChildRowPackages,
} from "#shared/booking/page-packages.ts";
import { testGroup } from "#test-utils/factories.ts";
import { pagePackage, treePackage } from "./package-cap-fixtures.ts";

describe("buildPagePackage", () => {
  test("carries the group's display fields beside the loaded pricing", () => {
    const built = buildPagePackage(
      testGroup({
        description: "All the fun",
        hide_package_listings: true,
        id: 7,
        name: "Party Bundle",
        slug: "party",
        terms_and_conditions: "No mud",
      }),
      [1, 2],
      {
        dayPrices: new Map([[1, new Map([[2, 700]])]]),
        prices: new Map([[1, 400]]),
        quantities: new Map([[2, 3]]),
      },
    );
    expect(built).toEqual({
      dayPrices: new Map([[1, new Map([[2, 700]])]]),
      description: "All the fun",
      groupId: 7,
      hideListings: true,
      memberListingIds: [1, 2],
      name: "Party Bundle",
      prices: new Map([[1, 400]]),
      quantities: new Map([[2, 3]]),
      slug: "party",
      terms: "No mud",
    });
  });
});

describe("packageByMemberListingId / packageMemberIds", () => {
  test("maps each member to its package, first package winning overlaps", () => {
    const first = treePackage(7, [1, 2]);
    const second = treePackage(8, [2, 3]);
    const byMember = packageByMemberListingId([first, second]);
    expect(byMember.get(1)).toBe(first);
    expect(byMember.get(2)).toBe(first);
    expect(byMember.get(3)).toBe(second);
    expect(packageMemberIds([first, second])).toEqual(new Set([1, 2, 3]));
  });
});

describe("explicitStandaloneIds", () => {
  const listings = [
    { id: 1, slug: "bounc" },
    { id: 2, slug: "facep" },
    { id: 3, slug: "candy" },
  ];

  test("names members the cart also added by their own slug", () => {
    const ids = explicitStandaloneIds(
      listings,
      [treePackage(7, [1, 2])],
      ["pkg7s", "bounc", "candy"],
    );
    // Listing 3 is no member (always standalone) and listing 2's slug wasn't
    // in the cart, so only the dual-path member 1 is named.
    expect(ids).toEqual(new Set([1]));
  });

  test("never lets a hidden package's member sell standalone", () => {
    const ids = explicitStandaloneIds(
      listings,
      [treePackage(7, [1, 2], { hideListings: true })],
      ["pkg7s", "bounc"],
    );
    expect(ids).toEqual(new Set());
  });
});

describe("combinedPackageTerms", () => {
  test("joins each package's terms once, in page order", () => {
    const combined = combinedPackageTerms(
      [
        pagePackage(7, [1], { terms: "No mud" }),
        pagePackage(8, [2], { terms: "" }),
        pagePackage(9, [3], { terms: "No mud" }),
        pagePackage(10, [4], { terms: "Bring wellies" }),
      ],
      "fallback",
    );
    expect(combined).toBe("No mud\n\nBring wellies");
  });

  test("falls back when no package carries terms", () => {
    const combined = combinedPackageTerms(
      [pagePackage(7, [1], { terms: "" })],
      "House terms",
    );
    expect(combined).toBe("House terms");
  });
});

describe("soleParentPackageIds", () => {
  test("keeps a parent booked through exactly one package", () => {
    const sole = soleParentPackageIds([
      { listingId: 1, packageGroupId: 7 },
      { listingId: 1, packageGroupId: 7 },
      { listingId: 2, packageGroupId: 8 },
    ]);
    expect([...sole]).toEqual([
      [1, 7],
      [2, 8],
    ]);
  });

  test("drops a parent booked through two paths, even seen again later", () => {
    const sole = soleParentPackageIds([
      { listingId: 1, packageGroupId: 7 },
      { listingId: 1 },
      { listingId: 1, packageGroupId: 7 },
    ]);
    expect(sole.size).toBe(0);
  });

  test("drops parents only booked standalone", () => {
    const sole = soleParentPackageIds([{ listingId: 1 }]);
    expect(sole.size).toBe(0);
  });
});

describe("stampChildRowPackages", () => {
  test("stamps a child row with its parent's sole package", () => {
    const rows = stampChildRowPackages(
      [
        { packageGroupId: 7, parentListingId: 0 },
        { packageGroupId: 0, parentListingId: 1 },
      ],
      new Map([[1, 7]]),
    );
    expect(rows).toEqual([
      { packageGroupId: 7, parentListingId: 0 },
      { packageGroupId: 7, parentListingId: 1 },
    ]);
  });

  test("leaves top-level rows and children of pathless parents alone", () => {
    const rows = stampChildRowPackages(
      [
        { packageGroupId: 0, parentListingId: 0 },
        { packageGroupId: 0, parentListingId: 2 },
        {},
      ],
      new Map([[1, 7]]),
    );
    expect(rows).toEqual([
      { packageGroupId: 0, parentListingId: 0 },
      { packageGroupId: 0, parentListingId: 2 },
      {},
    ]);
  });

  test("never overwrites a row's own package tag", () => {
    const rows = stampChildRowPackages(
      [{ packageGroupId: 8, parentListingId: 1 }],
      new Map([[1, 7]]),
    );
    expect(rows).toEqual([{ packageGroupId: 8, parentListingId: 1 }]);
  });
});
