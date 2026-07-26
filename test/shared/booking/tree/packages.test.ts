import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { packageSubTree } from "#shared/booking/tree.ts";
import { twoPackageCart } from "#test/test-utils/package-cap-fixtures.ts";

describe("packageSubTree", () => {
  test("keeps just one package's member nodes", () => {
    const sub = packageSubTree(twoPackageCart(), 4);
    expect(sub.rootRef).toEqual({ groupId: 4, kind: "package" });
    expect(sub.nodes.map((n) => n.nodeKey)).toEqual(["package:4/member:8"]);
  });
});
