import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";

describe("largestRemainderAllocation", () => {
  test("returns zeros for non-positive amounts", () => {
    expect(largestRemainderAllocation([10, 20], 0)).toEqual([0, 0]);
  });

  test("returns zeros when all weights are zero", () => {
    expect(largestRemainderAllocation([0, 0], 10)).toEqual([0, 0]);
  });

  test("allocates exactly by largest remainders with index tie-breaks", () => {
    expect(largestRemainderAllocation([1000, 1000, 1000], 100)).toEqual([
      34, 33, 33,
    ]);
  });

  test("awards leftovers to the largest fractional remainders", () => {
    expect(largestRemainderAllocation([1, 1, 5], 2)).toEqual([0, 0, 2]);
  });

  test("respects allocation caps and custom tie-breaks", () => {
    expect(
      largestRemainderAllocation([2, 2], 1, {
        canReceive: (index, floor) => index === 1 || floor < 1,
        tieBreaker: (index) => -index,
      }),
    ).toEqual([0, 1]);
  });
});
