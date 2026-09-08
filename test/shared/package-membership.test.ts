import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  packageChildEdgeConflict,
  packageChildEdgeError,
  packageChildEdgeErrorOrNull,
  packageGroups,
  packageMemberCapError,
  packageMemberError,
} from "#shared/package-membership.ts";

/** Build the edge set the member rules read (empty by default). */
const edges = (
  over: { childIds?: number[]; parentIds?: number[] } = {},
): { childIds: number[]; parentIds: number[] } => ({
  childIds: over.childIds ?? [],
  parentIds: over.parentIds ?? [],
});

/** A named listing with the given pay-more flag. */
const listing = (
  name: string,
  canPayMore = false,
): { name: string; can_pay_more: boolean } => ({
  can_pay_more: canPayMore,
  name,
});

describe("packageMemberError", () => {
  // Each blocking case asserts the complete localized message: which rule won
  // AND that the listing name interpolates into it.
  test("blocks a pay-what-you-want listing regardless of edges or hide flag", () => {
    // Decided by the listing alone: even with no edges and a visible package.
    expect(
      packageMemberError(listing("Balloon Ride", true), edges(), false),
    ).toBe(t("error.package_member_pay_more", { name: "Balloon Ride" }));
  });

  test("the pay-what-you-want rule wins over the add-on rule", () => {
    expect(
      packageMemberError(
        listing("Balloon Ride", true),
        edges({ parentIds: [7] }),
        false,
      ),
    ).toBe(t("error.package_member_pay_more", { name: "Balloon Ride" }));
  });

  test("blocks a listing that is another listing's add-on (has a parent)", () => {
    expect(
      packageMemberError(
        listing("Face Paint"),
        edges({ parentIds: [7] }),
        false,
      ),
    ).toBe(t("error.package_member_is_addon", { name: "Face Paint" }));
  });

  test("the add-on rule wins over hidden child gating", () => {
    expect(
      packageMemberError(
        listing("Day Pass"),
        edges({ childIds: [9], parentIds: [7] }),
        true,
      ),
    ).toBe(t("error.package_member_is_addon", { name: "Day Pass" }));
  });

  test("blocks a child-gating member only when the package is hidden", () => {
    expect(
      packageMemberError(listing("Day Pass"), edges({ childIds: [9] }), true),
    ).toBe(
      t("error.package_member_gates_children_hidden", { name: "Day Pass" }),
    );
  });

  test("allows a child-gating member on a VISIBLE package", () => {
    // The visible package renders the child selector, so gating is fine.
    expect(
      packageMemberError(listing("Day Pass"), edges({ childIds: [9] }), false),
    ).toBeNull();
  });

  test("treats an omitted hide flag as not hidden", () => {
    expect(
      packageMemberError(
        listing("Day Pass"),
        edges({ childIds: [9] }),
        undefined,
      ),
    ).toBeNull();
  });

  test("allows a hidden-package member that gates NO children", () => {
    expect(packageMemberError(listing("Day Pass"), edges(), true)).toBeNull();
  });

  test("allows a plain fixed-price listing with no edges", () => {
    expect(packageMemberError(listing("Day Pass"), edges(), false)).toBeNull();
  });
});

describe("packageMemberCapError", () => {
  /** A member row with the given pick count and per-order cap. */
  const member = (name: string, quantity: number, maxQuantity: number) => ({
    max_quantity: maxQuantity,
    name,
    quantity,
  });

  test("refuses a pick count above the member's per-order cap", () => {
    expect(packageMemberCapError(member("Boat Trip", 2, 1))).toBe(
      t("error.package_member_cap", {
        max_quantity: 1,
        name: "Boat Trip",
        quantity: 2,
      }),
    );
  });

  test("names the member whose cap the pick count breaks", () => {
    const message = packageMemberCapError(member("Day Pass", 4, 3))!;
    expect(message).toContain("Day Pass");
    expect(message).toContain("3");
  });

  test("allows a pick count at the cap", () => {
    expect(packageMemberCapError(member("Day Pass", 3, 3))).toBeNull();
  });

  test("treats an omitted pick count as one unit per package", () => {
    expect(
      packageMemberCapError({ max_quantity: 1, name: "Day Pass" }),
    ).toBeNull();
  });

  test("refuses a member that sells nothing when the pick count is omitted", () => {
    expect(packageMemberCapError({ max_quantity: 0, name: "Day Pass" })).toBe(
      t("error.package_member_cap", {
        max_quantity: 0,
        name: "Day Pass",
        quantity: 1,
      }),
    );
  });

  test("allows a pick count below the cap", () => {
    expect(packageMemberCapError(member("Day Pass", 1, 9))).toBeNull();
  });
});

describe("packageGroups", () => {
  test("keeps only package groups", () => {
    expect(
      packageGroups([
        { id: 1, is_package: false },
        { id: 2, is_package: true },
      ]),
    ).toEqual([{ id: 2, is_package: true }]);
  });
});

describe("packageChildEdgeError", () => {
  test("explains a hidden-package parent gaining children", () => {
    expect(packageChildEdgeError("gate_in_hidden")).toBe(
      t("error.package_gate_in_hidden"),
    );
  });

  test("explains a package member chosen as a child", () => {
    expect(packageChildEdgeError("child_is_member")).toBe(
      t("error.package_child_is_member"),
    );
  });

  test("keeps no conflict as null", () => {
    expect(packageChildEdgeErrorOrNull(null)).toBeNull();
  });

  test("turns an edge conflict into its message", () => {
    expect(packageChildEdgeErrorOrNull("child_is_member")).toBe(
      t("error.package_child_is_member"),
    );
  });
});

describe("packageChildEdgeConflict", () => {
  test("checks edge presence, hidden parents, and packaged children in order", async () => {
    const conflict = (
      childIds: number[],
      parentIsHiddenPackageMember: boolean,
      childIsPackageMember: boolean,
    ) =>
      packageChildEdgeConflict(
        childIds,
        () => parentIsHiddenPackageMember,
        () => childIsPackageMember,
      );

    await expect(conflict([], true, true)).resolves.toBeNull();
    await expect(conflict([1], true, true)).resolves.toBe("gate_in_hidden");
    await expect(conflict([1], false, true)).resolves.toBe("child_is_member");
    await expect(conflict([1], false, false)).resolves.toBeNull();
  });

  test("awaits asynchronous package checks", async () => {
    await expect(
      packageChildEdgeConflict(
        [1],
        async () => false,
        async () => false,
      ),
    ).resolves.toBeNull();
  });
});
