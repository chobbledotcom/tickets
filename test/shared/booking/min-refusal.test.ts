import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { belowMinError, packageBundleMinError } from "#booking/min-refusal.ts";

describe("belowMinError", () => {
  test("answers the caller's message for a count below the minimum", () => {
    expect(belowMinError(2, 3, "refused")).toBe("refused");
    expect(belowMinError(1, 3, "refused")).toBe("refused");
  });

  test("answers null for zero and for a count the minimum allows", () => {
    expect(belowMinError(0, 3, "refused")).toBeNull();
    expect(belowMinError(3, 3, "refused")).toBeNull();
    expect(belowMinError(5, 3, "refused")).toBeNull();
  });
});

describe("packageBundleMinError", () => {
  const member = (fixed: number, minQuantity: number) => ({
    fixed,
    minQuantity,
    name: `Member ${fixed}`,
  });

  test("refuses the first member whose units the bundles cannot serve", () => {
    // One bundle gives a fixed-1 member 1 unit against a minimum of 2.
    expect(packageBundleMinError([member(1, 2), member(3, 3)], 1)).toContain(
      "Member 1 sells at least 2 tickets per booking.",
    );
  });

  test("multiplies the fixed count by the bundle count", () => {
    // Three units per bundle serve a minimum of 2 from the first bundle; a
    // subtraction instead of a product would read 1 and refuse.
    expect(packageBundleMinError([member(3, 2)], 2)).toBeNull();
    expect(packageBundleMinError([member(3, 7)], 2)).toContain(
      "Member 3 sells at least 7 tickets per booking.",
    );
  });

  test("answers null for zero bundles and for counts every member serves", () => {
    expect(packageBundleMinError([member(1, 2)], 0)).toBeNull();
    expect(packageBundleMinError([member(2, 2)], 1)).toBeNull();
    expect(packageBundleMinError([member(2, 2), member(1, 5)], 5)).toBeNull();
  });
});
