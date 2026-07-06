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

  test("gives the extra unit to the biggest fractional share, not the biggest floor", () => {
    // weight 3 has the bigger whole share (2) but the smaller fraction (0.25);
    // weight 1 has the smaller whole share (0) but the bigger fraction (0.75),
    // so the leftover unit must go to weight 1.
    expect(largestRemainderAllocation([3, 1], 3)).toEqual([2, 1]);
  });

  test("breaks a tie using the tie-break values themselves, not their sum", () => {
    // weights 3 and 5 land on the same fractional share (0.5), so the
    // tie-break values (-3 for index 0, 2 for index 1) decide the winner:
    // -3 is the smaller value, so index 0 gets the leftover unit.
    expect(
      largestRemainderAllocation([3, 5, 2], 5, {
        tieBreaker: (index) => [-3, 2, -1][index]!,
      }),
    ).toEqual([2, 2, 1]);
  });

  test("still computes a real allocation when the total is a small positive number", () => {
    expect(largestRemainderAllocation([0.4, 0.4], 1)).toEqual([1, 0]);
  });

  test("returns zeros for an amount that is negative but greater than -1", () => {
    expect(largestRemainderAllocation([10, 20], -0.5)).toEqual([0, 0]);
  });

  test("never calls the tie-break or cap hooks when the amount is exactly zero", () => {
    // A zero amount must short-circuit before any per-weight logic runs, even
    // though the maths would come out to zero anyway if it didn't.
    const calls: string[] = [];
    largestRemainderAllocation([10, 20], 0, {
      canReceive: (index) => {
        calls.push(`canReceive:${index}`);
        return true;
      },
      tieBreaker: (index) => {
        calls.push(`tieBreaker:${index}`);
        return index;
      },
    });
    expect(calls).toEqual([]);
  });
});
