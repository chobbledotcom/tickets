import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type MovePlace, moveKey } from "#shared/reorder.ts";

describe("moveKey", () => {
  const keys = ["page:1", "listing:2", "group:3", "page:4"];

  for (const [title, target, place, anchor, expected] of [
    [
      "an up arrow moves the row before the row above",
      "group:3",
      "before",
      "listing:2",
      ["page:1", "group:3", "listing:2", "page:4"],
    ],
    [
      "a down arrow moves the row after the row below",
      "listing:2",
      "after",
      "group:3",
      ["page:1", "group:3", "listing:2", "page:4"],
    ],
    [
      "a drop moves the row several places up",
      "page:4",
      "before",
      "page:1",
      ["page:4", "page:1", "listing:2", "group:3"],
    ],
    [
      "a drop moves the row several places down",
      "page:1",
      "after",
      "page:4",
      ["listing:2", "group:3", "page:4", "page:1"],
    ],
    [
      "a move to where the row sits keeps the order",
      "group:3",
      "after",
      "listing:2",
      keys,
    ],
  ] as const) {
    test(title, () => {
      expect(moveKey(keys, target, place, anchor)).toEqual(expected);
    });
  }

  test("null when the row or the anchor is missing, or they are the same", () => {
    expect(moveKey(keys, "listing:99", "before", "page:1")).toBeNull();
    expect(moveKey(keys, "page:1", "after", "listing:99")).toBeNull();
    expect(moveKey(keys, "page:1", "after", "page:1")).toBeNull();
  });

  /** Every move one row can make: each other row as the anchor, each place. */
  const movesOf = (target: string) =>
    keys
      .filter((key) => key !== target)
      .flatMap((anchor) =>
        (["before", "after"] as MovePlace[]).map((place) => ({
          anchor,
          place,
        })),
      );

  test("keeps every key exactly once for every move", () => {
    for (const target of keys) {
      for (const { anchor, place } of movesOf(target)) {
        const order = moveKey(keys, target, place, anchor)!;
        expect(order.toSorted()).toEqual(keys.toSorted());
        const at = order.indexOf(target);
        expect(order[place === "before" ? at + 1 : at - 1]).toBe(anchor);
      }
    }
  });

  test("works over numeric row ids", () => {
    expect(moveKey([10, 20, 30], 30, "before", 10)).toEqual([30, 10, 20]);
  });
});
