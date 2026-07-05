import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groupsTable } from "#shared/db/groups.ts";
import {
  concealMemberNames,
  concealNamesByListingId,
  memberStandInName,
  namesConcealed,
  packagePrivacy,
  packagePrivacyOfDisplay,
  resolveNamesConcealed,
  standInNamesByListingId,
} from "#shared/package-privacy.ts";
import { createTestGroup, describeWithEnv } from "#test-utils";

const HIDDEN = packagePrivacy(true, "Welcome Pack");
const SHOWN = packagePrivacy(false, "Welcome Pack");

describe("package privacy (pure)", () => {
  test("a hidden package conceals member names behind the package name", () => {
    expect(namesConcealed(HIDDEN)).toBe(true);
    expect(memberStandInName(HIDDEN)).toBe("Welcome Pack");
  });

  test("a visible package (and a non-package) names members as usual", () => {
    expect(namesConcealed(SHOWN)).toBe(false);
    expect(memberStandInName(SHOWN)).toBeUndefined();
    expect(packagePrivacyOfDisplay(null)).toEqual({ kind: "visible" });
  });

  test("a display resolves through the same constructor", () => {
    expect(
      packagePrivacyOfDisplay({ hideListings: true, name: "Box" }),
    ).toEqual({ kind: "hidden", packageName: "Box" });
  });

  test("concealMemberNames renames every line, keeping ids and prices", () => {
    const items = [
      { listingId: 1, name: "Secret A", unitPrice: 500 },
      { listingId: 2, name: "Secret B", unitPrice: 700 },
    ];
    const result = concealMemberNames(items, HIDDEN);
    expect(result.map((i) => i.name)).toEqual(["Welcome Pack", "Welcome Pack"]);
    // Ids/prices are untouched so the webhook still revalidates each member.
    expect(result.map((i) => i.listingId)).toEqual([1, 2]);
    expect(result.map((i) => i.unitPrice)).toEqual([500, 700]);
  });

  test("concealMemberNames is a no-op for a visible order", () => {
    const items = [{ name: "Member" }];
    expect(concealMemberNames(items, SHOWN)).toBe(items);
  });
});

describe("per-listing stand-in names (several bundles per page)", () => {
  const packages = [
    {
      hideListings: true,
      memberListingIds: [1, 2],
      name: "Secret Box",
    },
    {
      hideListings: false,
      memberListingIds: [3],
      name: "Open Kit",
    },
  ];
  const childIds = (memberId: number): number[] => (memberId === 2 ? [9] : []);

  test("covers a hidden package's members AND their required children", () => {
    const standIns = standInNamesByListingId(packages, childIds);
    expect(standIns.get(1)).toBe("Secret Box");
    expect(standIns.get(2)).toBe("Secret Box");
    // Member 2's required child books as part of the hidden bundle.
    expect(standIns.get(9)).toBe("Secret Box");
  });

  test("a visible package's members are never concealed", () => {
    const standIns = standInNamesByListingId(packages, childIds);
    expect(standIns.has(3)).toBe(false);
    expect(standIns.size).toBe(3);
  });

  test("concealNamesByListingId renames only the concealed lines", () => {
    const standIns = standInNamesByListingId(packages, childIds);
    const items = [
      { listingId: 1, name: "Secret A", unitPrice: 500 },
      { listingId: 3, name: "Open Thing", unitPrice: 700 },
    ];
    const result = concealNamesByListingId(items, standIns);
    expect(result.map((i) => i.name)).toEqual(["Secret Box", "Open Thing"]);
    expect(result.map((i) => i.unitPrice)).toEqual([500, 700]);
  });

  test("concealNamesByListingId is a no-op when nothing is concealed", () => {
    const items = [{ listingId: 3, name: "Open Thing" }];
    expect(concealNamesByListingId(items, new Map())).toBe(items);
  });
});

describeWithEnv("resolveNamesConcealed (fail-safe)", { db: true }, () => {
  test("an order booking no packages never conceals", async () => {
    expect(await resolveNamesConcealed([])).toBe(false);
  });

  test("a live package resolves its own hide flag", async () => {
    const shown = await createTestGroup({ isPackage: true, name: "Open Kit" });
    expect(await resolveNamesConcealed([shown.id])).toBe(false);

    const hidden = await createTestGroup({ isPackage: true, name: "Box Kit" });
    await groupsTable.update(hidden.id, { hidePackageListings: true });
    expect(await resolveNamesConcealed([hidden.id])).toBe(true);
  });

  test("hidden when ANY of several booked packages hides its listings", async () => {
    const shown = await createTestGroup({ isPackage: true, name: "Kit A" });
    const hidden = await createTestGroup({ isPackage: true, name: "Kit B" });
    await groupsTable.update(hidden.id, { hidePackageListings: true });
    expect(await resolveNamesConcealed([shown.id, hidden.id])).toBe(true);
  });

  test("a package id that no longer resolves fails SAFE as hidden", async () => {
    // The stale group may have been hidden; the refund path must not name its
    // members either way.
    const gone = await createTestGroup({ isPackage: true, name: "Gone Kit" });
    await groupsTable.deleteById(gone.id);
    expect(await resolveNamesConcealed([gone.id])).toBe(true);
  });
});
