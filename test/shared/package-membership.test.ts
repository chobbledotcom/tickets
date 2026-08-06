import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  packageChildEdgeConflict,
  packageChildEdgeError,
  packageChildEdgeErrorOrNull,
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
});
