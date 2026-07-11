import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  packageChildEdgeError,
  packageMemberBlock,
  packageMemberBlockError,
} from "#shared/package-membership.ts";

/** Build the edge set the block rule reads (empty by default). */
const edges = (
  over: { childIds?: number[]; parentIds?: number[] } = {},
): { childIds: number[]; parentIds: number[] } => ({
  childIds: over.childIds ?? [],
  parentIds: over.parentIds ?? [],
});

describe("packageMemberBlock", () => {
  test("blocks a pay-what-you-want listing regardless of edges or hide flag", () => {
    // Decided by the listing alone: even with no edges and a visible package.
    expect(packageMemberBlock({ can_pay_more: true }, edges(), false)).toBe(
      "pay_more",
    );
  });

  test("blocks a listing that is another listing's add-on (has a parent)", () => {
    expect(
      packageMemberBlock(
        { can_pay_more: false },
        edges({ parentIds: [7] }),
        false,
      ),
    ).toBe("is_addon");
  });

  test("blocks a child-gating member only when the package is hidden", () => {
    expect(
      packageMemberBlock(
        { can_pay_more: false },
        edges({ childIds: [9] }),
        true,
      ),
    ).toBe("gates_children_hidden");
  });

  test("allows a child-gating member on a VISIBLE package", () => {
    // The visible package renders the child selector, so gating is fine.
    expect(
      packageMemberBlock(
        { can_pay_more: false },
        edges({ childIds: [9] }),
        false,
      ),
    ).toBeNull();
  });

  test("treats an omitted hide flag as not hidden", () => {
    expect(
      packageMemberBlock(
        { can_pay_more: false },
        edges({ childIds: [9] }),
        undefined,
      ),
    ).toBeNull();
  });

  test("allows a hidden-package member that gates NO children", () => {
    expect(
      packageMemberBlock({ can_pay_more: false }, edges(), true),
    ).toBeNull();
  });

  test("allows a plain fixed-price listing with no edges", () => {
    expect(
      packageMemberBlock({ can_pay_more: false }, edges(), false),
    ).toBeNull();
  });
});

describe("packageMemberBlockError", () => {
  // Each case asserts the complete localized message: which key the block maps
  // to AND that the listing name interpolates into it.
  test("names the listing and the pay-what-you-want reason", () => {
    expect(packageMemberBlockError("Balloon Ride", "pay_more")).toBe(
      t("error.package_member_pay_more", { name: "Balloon Ride" }),
    );
  });

  test("names the listing and the add-on reason", () => {
    expect(packageMemberBlockError("Face Paint", "is_addon")).toBe(
      t("error.package_member_is_addon", { name: "Face Paint" }),
    );
  });

  test("names the listing and the hidden-gate reason", () => {
    expect(packageMemberBlockError("Day Pass", "gates_children_hidden")).toBe(
      t("error.package_member_gates_children_hidden", { name: "Day Pass" }),
    );
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
});
