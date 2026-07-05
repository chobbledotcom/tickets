import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { resolved } from "./booking-model-fixtures.ts";

describe("buildBookingTree — root ref", () => {
  test("defaults to a listing root using the given slugs when no root is given", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 1 })],
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ kind: "listing", slugs: ["ab12c"] });
  });

  test("uses the given group root", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 1 })],
      root: { groupId: 7, kind: "group" },
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ groupId: 7, kind: "group" });
  });

  test("uses the given package root", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 1 })],
      root: { groupId: 7, kind: "package" },
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ groupId: 7, kind: "package" });
  });
});

describe("buildBookingTree — standalone listing nodes (no root)", () => {
  test("builds a top-level node addressed by its own listing id", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 5 })],
      slugs: ["ab12c"],
    });
    const node = tree.nodes[0]!;
    expect(node.nodeKey).toBe("listing:5");
    expect(node.edgeRef).toEqual({ kind: "none" });
    expect(node.listingId).toBe(5);
    expect(node.dateSpan).toEqual({ kind: "NONE" });
    expect(node.visibility).toBe("SHOWN");
    expect(node.quantityRule).toEqual({ kind: "BUYER_CHOICE" });
  });

  test("multiple listings each become their own top-level node, in order", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 1 }), resolved({ id: 2 })],
      slugs: ["ab12c"],
    });
    expect(tree.nodes.map((n) => n.nodeKey)).toEqual([
      "listing:1",
      "listing:2",
    ]);
  });
});

describe("buildBookingTree — group member nodes", () => {
  test("builds a node addressed by group and listing id", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 5 })],
      root: { groupId: 3, kind: "group" },
      slugs: ["ab12c"],
    });
    const node = tree.nodes[0]!;
    expect(node.nodeKey).toBe("group:3/member:5");
    expect(node.edgeRef).toEqual({ groupId: 3, kind: "group_member" });
    expect(node.quantityRule).toEqual({ kind: "BUYER_CHOICE" });
  });
});

describe("buildBookingTree — package member nodes", () => {
  const packageMemberTree = (
    overrides: {
      hidePackageListings?: boolean;
      packageQuantities?: ReadonlyMap<number, number>;
    } = {},
  ) =>
    buildBookingTree({
      listings: [resolved({ id: 5 })],
      root: { groupId: 3, kind: "package" },
      slugs: ["ab12c"],
      ...overrides,
    });

  test("builds a node addressed by the package group and listing id", () => {
    const node = packageMemberTree().nodes[0]!;
    expect(node.nodeKey).toBe("package:3/member:5");
    expect(node.edgeRef).toEqual({ groupId: 3, kind: "group_member" });
    expect(node.dateSpan).toEqual({ kind: "NONE" });
  });

  test("defaults the fixed quantity to 1 when none is given", () => {
    expect(packageMemberTree().nodes[0]!.quantityRule).toEqual({
      kind: "FIXED",
      qty: 1,
    });
  });

  test("uses the given fixed quantity for a member", () => {
    const tree = packageMemberTree({
      packageQuantities: new Map([[5, 3]]),
    });
    expect(tree.nodes[0]!.quantityRule).toEqual({ kind: "FIXED", qty: 3 });
  });

  test("is shown by default", () => {
    expect(packageMemberTree().nodes[0]!.visibility).toBe("SHOWN");
  });

  test("is hidden when the package hides its listings", () => {
    const tree = packageMemberTree({ hidePackageListings: true });
    expect(tree.nodes[0]!.visibility).toBe("HIDDEN");
  });
});
