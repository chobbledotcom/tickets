import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { planReorder } from "#shared/reorder.ts";

describe("planReorder", () => {
  const keys = ["page:1", "listing:2", "group:3"];

  test("swaps with the correct neighbour", () => {
    expect(planReorder(keys, "listing:2", "up")).toEqual([
      "listing:2",
      "page:1",
    ]);
    expect(planReorder(keys, "listing:2", "down")).toEqual([
      "listing:2",
      "group:3",
    ]);
  });

  test("null at boundaries and for a missing key", () => {
    expect(planReorder(keys, "page:1", "up")).toBeNull();
    expect(planReorder(keys, "group:3", "down")).toBeNull();
    expect(planReorder(keys, "listing:99", "up")).toBeNull();
  });

  test("works over any key type, e.g. numeric row ids", () => {
    expect(planReorder([10, 20, 30], 20, "up")).toEqual([20, 10]);
    expect(planReorder([10, 20, 30], 20, "down")).toEqual([20, 30]);
    expect(planReorder([10, 20, 30], 10, "up")).toBeNull();
  });

  test("a move followed by its opposite restores the order (self-inverse)", () => {
    // Applying planReorder's swap and then the opposite move's swap is the
    // identity, for every non-boundary position.
    const applySwap = (
      order: readonly string[],
      [a, b]: readonly [string, string],
    ): string[] => order.map((k) => (k === a ? b : k === b ? a : k));
    for (const [target, dir, opposite] of [
      ["listing:2", "down", "up"],
      ["listing:2", "up", "down"],
      ["page:1", "down", "up"],
      ["group:3", "up", "down"],
    ] as const) {
      const swap = planReorder(keys, target, dir);
      expect(swap, `${target} ${dir}`).not.toBeNull();
      const moved = applySwap(keys, swap!);
      const back = planReorder(moved, target, opposite);
      expect(back, `${target} ${opposite} back`).not.toBeNull();
      expect(applySwap(moved, back!)).toEqual(keys);
    }
  });
});
