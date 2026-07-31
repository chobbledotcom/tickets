import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { required } from "#test-utils/required.ts";

describe("the value a fixture says must be there", () => {
  test("hands back a value that is there", () => {
    expect(required({ id: 7 }, "payment")).toEqual({ id: 7 });
  });

  test("hands back a value that is there but falsy", () => {
    expect(required(0, "charge count")).toBe(0);
  });

  test("names what was missing when nothing came back", () => {
    expect(() => required(undefined, "payment")).toThrow("Missing payment");
  });

  test("treats an empty row the same as nothing at all", () => {
    expect(() => required(null, "kept booking")).toThrow(
      "Missing kept booking",
    );
  });
});
