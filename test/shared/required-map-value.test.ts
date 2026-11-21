import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { requiredMapValueWithMessage } from "#shared/required-map-value.ts";

describe("requiredMapValueWithMessage", () => {
  test("returns a stored value", () => {
    expect(
      requiredMapValueWithMessage(new Map([[4, "four"]]), 4, "missing"),
    ).toBe("four");
  });

  test("returns a stored falsy value", () => {
    expect(requiredMapValueWithMessage(new Map([[4, 0]]), 4, "missing")).toBe(
      0,
    );
  });

  test("throws the supplied message when the key is missing", () => {
    expect(() =>
      requiredMapValueWithMessage(new Map(), 4, "Number 4 missing"),
    ).toThrow("Number 4 missing");
  });
});
