import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { nodeFixedQuantity, packageSubTree } from "#booking/tree.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { twoPackageCart } from "#test-utils/package-cap-fixtures.ts";

describe("packageSubTree", () => {
  test("keeps just one package's member nodes", () => {
    const sub = packageSubTree(twoPackageCart(), 4);
    expect(sub.rootRef).toEqual({ groupId: 4, kind: "package" });
    expect(sub.nodes.map((n) => n.nodeKey)).toEqual(["package:4/member:8"]);
  });

  test("nodeFixedQuantity carries a FIXED member's qty and gives any other node one", () => {
    const base = {
      children: [],
      dateSpan: { kind: "NONE" },
      edgeRef: { groupId: 5, kind: "group_member" },
      listing: testListingWithCount({ id: 1 }),
      listingId: 1,
      nodeKey: "group:5/member:1",
      priceRule: { kind: "BASE" },
      visibility: "SHOWN",
    } as const;

    expect(
      nodeFixedQuantity({ ...base, quantityRule: { kind: "FIXED", qty: 3 } }),
    ).toBe(3);

    // A buyer-chosen node counts once per unit: the package count multiplies
    // it, so a 0 here would drop the member from every total.
    expect(
      nodeFixedQuantity({ ...base, quantityRule: { kind: "BUYER_CHOICE" } }),
    ).toBe(1);
  });
});
