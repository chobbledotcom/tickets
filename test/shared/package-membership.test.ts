import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
  test("names the listing and the pay-what-you-want reason", () => {
    const message = packageMemberBlockError("Balloon Ride", "pay_more");
    expect(message).toContain("Packages cannot contain");
    expect(message).toContain("Balloon Ride");
    expect(message).toContain("Allow Pay More");
  });

  test("names the listing and the add-on reason", () => {
    const message = packageMemberBlockError("Face Paint", "is_addon");
    expect(message).toContain("Packages cannot contain");
    expect(message).toContain("Face Paint");
    expect(message).toContain("add-on");
  });

  test("names the listing and the hidden-gate reason", () => {
    const message = packageMemberBlockError(
      "Day Pass",
      "gates_children_hidden",
    );
    expect(message).toContain("Packages cannot contain");
    expect(message).toContain("Day Pass");
    expect(message).toContain("hidden");
  });
});

describe("packageChildEdgeError", () => {
  test("explains a hidden-package parent gaining children", () => {
    const message = packageChildEdgeError("gate_in_hidden");
    expect(message).toContain("hidden package");
    expect(message).toContain("add-ons");
  });

  test("explains a package member chosen as a child", () => {
    const message = packageChildEdgeError("child_is_member");
    expect(message).toContain("belongs to a package");
    expect(message).toContain("add-on");
  });
});
