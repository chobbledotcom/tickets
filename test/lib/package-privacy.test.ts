import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groupsTable } from "#shared/db/groups.ts";
import {
  concealMemberNames,
  memberStandInName,
  namesConcealed,
  packagePrivacy,
  packagePrivacyOfCtx,
  packagePrivacyOfDisplay,
  resolveNamesConcealed,
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

  test("the booking ctx carries its privacy alongside the package id", () => {
    expect(
      packagePrivacyOfCtx({ groupName: "Box", hidePackageListings: true }),
    ).toEqual({ kind: "hidden", packageName: "Box" });
    expect(packagePrivacyOfCtx({ groupName: "Plain Group" })).toEqual({
      kind: "visible",
    });
  });

  test("does not report hidden when hidePackageListings is true but there is no group name", () => {
    expect(packagePrivacyOfCtx({ hidePackageListings: true })).toEqual({
      kind: "visible",
    });
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

describeWithEnv("resolveNamesConcealed (fail-safe)", { db: true }, () => {
  test("a non-package order never conceals", async () => {
    expect(await resolveNamesConcealed(undefined)).toBe(false);
  });

  test("a live package resolves its own hide flag", async () => {
    const shown = await createTestGroup({ isPackage: true, name: "Open Kit" });
    expect(await resolveNamesConcealed(shown.id)).toBe(false);

    const hidden = await createTestGroup({ isPackage: true, name: "Box Kit" });
    await groupsTable.update(hidden.id, { hidePackageListings: true });
    expect(await resolveNamesConcealed(hidden.id)).toBe(true);
  });

  test("a package id that no longer resolves fails SAFE as hidden", async () => {
    // The stale group may have been hidden; the refund path must not name its
    // members either way.
    const gone = await createTestGroup({ isPackage: true, name: "Gone Kit" });
    await groupsTable.deleteById(gone.id);
    expect(await resolveNamesConcealed(gone.id)).toBe(true);
  });
});
