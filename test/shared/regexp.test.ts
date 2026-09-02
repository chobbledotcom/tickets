import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { escapeRegExp } from "#shared/regexp.ts";

describe("escapeRegExp", () => {
  /** Listed one by one rather than as one string, so no two of them sit
   * beside each other and read as a template placeholder. */
  const SPECIAL = [
    ".",
    "*",
    "+",
    "?",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
    "\\",
  ];

  test("makes every special character match itself", () => {
    for (const special of SPECIAL) {
      expect(new RegExp(escapeRegExp(special)).test(special)).toBe(true);
    }
  });

  test("leaves a literal that needs no escaping alone", () => {
    expect(escapeRegExp("listings")).toBe("listings");
  });

  test("stops a dot from matching a character it is not", () => {
    expect(new RegExp(escapeRegExp("a.c")).test("abc")).toBe(false);
    expect(new RegExp(escapeRegExp("a.c")).test("a.c")).toBe(true);
  });

  test("escapes every special character in one literal, not just the first", () => {
    expect(new RegExp(escapeRegExp("a.b*c")).test("a.b*c")).toBe(true);
    expect(new RegExp(escapeRegExp("a.b*c")).test("axbbc")).toBe(false);
  });

  test("has nothing to escape in an empty literal", () => {
    expect(escapeRegExp("")).toBe("");
  });
});
