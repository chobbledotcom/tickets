import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { belowMinError } from "#booking/min-refusal.ts";

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
