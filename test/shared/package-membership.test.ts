import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  packageChildEdgeConflict,
  packageChildEdgeError,
  packageChildEdgeErrorOrNull,
  packageGroups,
  packageMemberError,
  packageMemberQuantityBroken,
  planInGroupError,
  planRuleError,
  sitePlanMemberError,
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
  test("the built-site plan refusal names the listing with the groups copy", () => {
    expect(sitePlanMemberError("Website Plan")).toBe(
      t("error.group_member_site_plan", { name: "Website Plan" }),
    );
  });

  test("planInGroupError refuses a plan and allows a non-plan", () => {
    expect(planInGroupError(true, "Website Plan")).toBe(
      t("error.group_member_site_plan", { name: "Website Plan" }),
    );
    expect(planInGroupError(false, "Day Pass")).toBeNull();
    expect(planInGroupError(undefined, "Day Pass")).toBeNull();
  });

  test("planRuleError spares non-plans and names the first broken facet", () => {
    // The renewal tier rules call it with these facets in this order.
    const facets: [boolean, string][] = [
      [true, "error.initial_site_months_required"],
      [false, "error.assign_built_site_not_tier"],
    ];
    expect(planRuleError(false, facets)).toBeNull();
    expect(planRuleError(undefined, facets)).toBeNull();
    expect(planRuleError(true, facets)).toBe(
      t("error.initial_site_months_required"),
    );
    expect(planRuleError(true, [])).toBeNull();
  });

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

describe("packageMemberQuantityBroken", () => {
  /** A member row with the given pick count and the bounds it sells within. */
  const member = (
    over: {
      max_quantity?: number;
      min_quantity?: number;
      quantity?: number;
    } = {},
  ) => ({
    max_quantity: over.max_quantity ?? 5,
    min_quantity: over.min_quantity ?? 1,
    quantity: over.quantity,
  });

  test("refuses a pick count above the member's per-order cap", () => {
    expect(packageMemberQuantityBroken(member({ quantity: 6 }))).toEqual({
      quantity: 6,
      reason: "cap",
    });
  });

  test("allows a pick count at the cap", () => {
    expect(packageMemberQuantityBroken(member({ quantity: 5 }))).toBeNull();
  });

  test("allows a pick count below the cap", () => {
    expect(packageMemberQuantityBroken(member({ quantity: 1 }))).toBeNull();
  });

  test("treats an omitted pick count as one unit per package", () => {
    expect(packageMemberQuantityBroken(member())).toBeNull();
    expect(packageMemberQuantityBroken(member({ max_quantity: 0 }))).toEqual({
      quantity: 1,
      reason: "cap",
    });
  });

  test("refuses a pick count below the listing's minimum", () => {
    expect(
      packageMemberQuantityBroken(member({ min_quantity: 2, quantity: 1 })),
    ).toEqual({ quantity: 1, reason: "min" });
  });

  test("allows a pick count at the minimum", () => {
    expect(
      packageMemberQuantityBroken(member({ min_quantity: 2, quantity: 2 })),
    ).toBeNull();
  });

  test("allows a zero pick count beside any minimum", () => {
    // Zero is the none choice, not a below-minimum purchase — the same
    // exemption the shared quantity rule reads.
    expect(packageMemberQuantityBroken(member({ quantity: 0 }))).toBeNull();
    expect(
      packageMemberQuantityBroken(member({ min_quantity: 2, quantity: 0 })),
    ).toBeNull();
  });

  test("refuses an omitted pick count below the minimum", () => {
    expect(packageMemberQuantityBroken(member({ min_quantity: 2 }))).toEqual({
      quantity: 1,
      reason: "min",
    });
  });

  test("checks the cap before the minimum", () => {
    // Both bounds break only when the stored minimum exceeds the stored
    // maximum — a listing the quantity rules refuse — so cap-first is the
    // order a crafted row meets.
    expect(
      packageMemberQuantityBroken(
        member({ max_quantity: 1, min_quantity: 4, quantity: 9 }),
      ),
    ).toEqual({ quantity: 9, reason: "cap" });
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
