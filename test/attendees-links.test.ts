import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseQuantity } from "#routes/admin/attendees-links.ts";

describe("parseQuantity", () => {
  test("parses valid number", () => {
    expect(parseQuantity("3", 10)).toBe(3);
  });

  test("clamps to 1 when below minimum", () => {
    expect(parseQuantity("0", 10)).toBe(1);
    expect(parseQuantity("-5", 10)).toBe(1);
  });

  test("clamps to max when above maximum", () => {
    expect(parseQuantity("99", 5)).toBe(5);
  });

  test("defaults to 1 for non-numeric input", () => {
    expect(parseQuantity("abc", 10)).toBe(1);
    expect(parseQuantity("", 10)).toBe(1);
  });
});
