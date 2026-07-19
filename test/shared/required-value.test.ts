import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { requireValue } from "#shared/required-value.ts";

describe("requireValue", () => {
  test("returns a present value", () => {
    expect(requireValue(7, "missing")).toBe(7);
  });

  test("throws the supplied message for a missing value", () => {
    expect(() => requireValue(null, "Expected value is missing")).toThrow(
      "Expected value is missing",
    );
  });
});
