import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { numberedLines, readMenuChoice } from "#scripts/site-migration/menu.ts";

describe("site menu", () => {
  test("turns a typed number into a zero-based row", () => {
    expect(readMenuChoice("2", ["a", "b", "c"])).toEqual({ chosen: "b" });
  });

  test("accepts padded answers", () => {
    expect(readMenuChoice("  1  ", ["a", "b", "c"])).toEqual({ chosen: "a" });
  });

  test("treats q, quit, and exit as stopping", () => {
    for (const answer of ["q", "QUIT", "exit"]) {
      expect(readMenuChoice(answer, ["a", "b", "c"])).toBe("quit");
    }
  });

  test("rejects a number outside the list", () => {
    expect(() => readMenuChoice("4", ["a", "b", "c"])).toThrow(
      "Choose a number between 1 and 3.",
    );
    expect(() => readMenuChoice("0", ["a", "b", "c"])).toThrow(
      "Choose a number between 1 and 3.",
    );
  });

  test("rejects an answer that is not a number", () => {
    expect(() => readMenuChoice("first", ["a", "b", "c"])).toThrow(
      "Type a number, or q to quit.",
    );
  });

  test("rejects a blank answer", () => {
    expect(() => readMenuChoice("  ", ["a", "b", "c"])).toThrow(
      "Choice is required.",
    );
  });

  test("stops when the person cancels the question", () => {
    expect(() => readMenuChoice(null, ["a", "b", "c"])).toThrow(
      "Migration cancelled.",
    );
  });

  test("numbers the list from one", () => {
    expect(numberedLines(["one", "two"])).toEqual(["  1. one", "  2. two"]);
  });
});
