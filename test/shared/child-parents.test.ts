import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { allocatedChildIds } from "#shared/child-parents.ts";

describe("allocatedChildIds", () => {
  const allocations = [
    { childId: 9, parentId: 1, qty: 1 },
    { childId: 9, parentId: 2, qty: 2 },
    { childId: 8, parentId: 2, qty: 1 },
    { childId: 7, parentId: 3, qty: 1 },
  ];

  test("keeps children allocated to any selected parent", () => {
    expect(allocatedChildIds(allocations, new Set([1, 2]))).toEqual(
      new Set([9, 8]),
    );
    expect(allocatedChildIds(allocations, new Set([1]))).toEqual(new Set([9]));
    expect(allocatedChildIds(allocations, new Set([3]))).toEqual(new Set([7]));
  });

  test("keeps no children without allocations or selected parents", () => {
    expect(allocatedChildIds([], new Set([1]))).toEqual(new Set());
    expect(allocatedChildIds(allocations, new Set())).toEqual(new Set());
  });
});
