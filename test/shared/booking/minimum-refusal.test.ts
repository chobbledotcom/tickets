import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { belowMinimumError } from "#booking/minimum-refusal.ts";

describe("belowMinimumError", () => {
  test("answers the caller's message for a count below the minimum", () => {
    expect(belowMinimumError(2, 3, "refused")).toBe("refused");
    expect(belowMinimumError(1, 3, "refused")).toBe("refused");
  });

  test("answers null for zero and for a count the minimum allows", () => {
    expect(belowMinimumError(0, 3, "refused")).toBeNull();
    expect(belowMinimumError(3, 3, "refused")).toBeNull();
    expect(belowMinimumError(5, 3, "refused")).toBeNull();
  });
});
