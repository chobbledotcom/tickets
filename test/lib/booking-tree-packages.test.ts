import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import type { TreePackage } from "#shared/booking/page-packages.ts";
import { packageSubTree } from "#shared/booking/tree.ts";
import { resolved } from "./booking-model-fixtures.ts";
import { treePackage as pkg } from "./package-cap-fixtures.ts";

/** A two-bundle cart beside a plain listing: packages 3 (member 7) and
 * 4 (member 8) with listing 9 standalone. */
const twoPackageCart = (
  overrides3: Partial<TreePackage> = {},
  overrides4: Partial<TreePackage> = {},
) =>
  buildBookingTree({
    listings: [resolved({ id: 7 }), resolved({ id: 8 }), resolved({ id: 9 })],
    packages: [pkg(3, [7], overrides3), pkg(4, [8], overrides4)],
    slugs: ["a", "b", "c"],
  });

describe("buildBookingTree — package members", () => {
  /** Package group 3 whose member 7 is itself a parent of (non-hidden) child 20,
   * built either shown or with `hide_package_listings`. */
  const packageMemberWithChild = (hidePackageListings: boolean) =>
    buildBookingTree({
      childrenByParentId: new Map([[7, [resolved({ id: 20, slug: "kid20" })]]]),
      listings: [resolved({ id: 7, slug: "tent1" })],
      packages: [
        pkg(3, [7], {
          hideListings: hidePackageListings,
          quantities: new Map([[7, 1]]),
        }),
      ],
      slugs: ["tent1"],
    });

  test("members are FIXED at their per-package quantity, priced by override", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({ id: 7, slug: "tent1" }),
        resolved({ id: 8, slug: "chr12" }),
      ],
      packages: [
        pkg(3, [7, 8], {
          prices: new Map([[7, 1500]]),
          quantities: new Map([[8, 4]]),
        }),
      ],
      slugs: ["tent1"],
    });
    const [tent, chair] = tree.nodes;
    expect(tent!.nodeKey).toBe("package:3/member:7");
    expect(tent!.quantityRule).toEqual({ kind: "FIXED", qty: 1 }); // defaults to 1
    expect(tent!.priceRule).toEqual({ amountMinor: 1500, kind: "OVERRIDE" });
    expect(chair!.quantityRule).toEqual({ kind: "FIXED", qty: 4 });
    expect(chair!.priceRule).toEqual({ kind: "BASE" });
  });

  test("hide_package_listings makes every member HIDDEN", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 }), resolved({ id: 8 })],
      packages: [pkg(3, [7, 8], { hideListings: true })],
      slugs: ["tent1"],
    });
    expect(tree.nodes.every((n) => n.visibility === "HIDDEN")).toBe(true);
  });

  test("shown by default when the package does not hide members", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 })],
      packages: [pkg(3, [7])],
      slugs: ["tent1"],
    });
    expect(tree.nodes[0]!.visibility).toBe("SHOWN");
  });

  test("each listing builds under ITS OWN package on a two-package cart", () => {
    // A cart selling two bundles side by side: member nodes must carry each
    // package's own group id, quantity, and override — never the other's.
    const tree = twoPackageCart(
      { prices: new Map([[7, 1500]]) },
      { quantities: new Map([[8, 2]]) },
    );
    const [seven, eight, nine] = tree.nodes;
    expect(seven!.nodeKey).toBe("package:3/member:7");
    expect(seven!.priceRule).toEqual({ amountMinor: 1500, kind: "OVERRIDE" });
    expect(eight!.nodeKey).toBe("package:4/member:8");
    expect(eight!.quantityRule).toEqual({ kind: "FIXED", qty: 2 });
    // The listing outside both packages stays a standalone buyer-choice node.
    expect(nine!.nodeKey).toBe("listing:9");
    expect(nine!.quantityRule).toEqual({ kind: "BUYER_CHOICE" });
  });

  test("packageSubTree keeps just one package's member nodes", () => {
    const sub = packageSubTree(twoPackageCart(), 4);
    expect(sub.rootRef).toEqual({ groupId: 4, kind: "package" });
    expect(sub.nodes.map((n) => n.nodeKey)).toEqual(["package:4/member:8"]);
  });

  test("a package member that is a parent nests its required children", () => {
    // The doc's model: a package member-parent is "a FIXED member node that
    // itself has a child node" — the child edge must not be dropped for packages.
    const tree = packageMemberWithChild(false);
    const member = tree.nodes[0]!;
    expect(member.quantityRule).toEqual({ kind: "FIXED", qty: 1 });
    expect(member.children).toHaveLength(1);
    expect(member.children[0]!.nodeKey).toBe("package:3/member:7/child:20");
    expect(member.children[0]!.edgeRef).toEqual({
      kind: "parent_child",
      parentId: 7,
    });
  });

  test("a hidden package member hides its auto-included children too", () => {
    // hide_package_listings hides the member AND its whole subtree, so a
    // HIDDEN-dropping projection can never name the child of a hidden member —
    // even when the child listing is not itself hidden.
    const tree = packageMemberWithChild(true);
    const member = tree.nodes[0]!;
    expect(member.visibility).toBe("HIDDEN");
    expect(member.children[0]!.listing.hidden).toBe(false);
    expect(member.children[0]!.visibility).toBe("HIDDEN");
  });
});
