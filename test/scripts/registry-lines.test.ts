import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { entryLines } from "#scripts/registry-lines.ts";

describe("entryLines", () => {
  test("keeps the lines that carry an entry", () => {
    expect(entryLines("one\ntwo")).toEqual(["one", "two"]);
  });

  test("drops a blank line and a line of only spaces", () => {
    expect(entryLines("one\n\n   \ntwo")).toEqual(["one", "two"]);
  });

  test("drops a whole-line comment, indented or not", () => {
    expect(entryLines("# a heading\n  # indented\none")).toEqual(["one"]);
  });

  test("keeps a line whose entry is followed by a comment", () => {
    expect(entryLines("one  # why")).toEqual(["one  # why"]);
  });

  test("keeps the line exactly as written, indentation included", () => {
    expect(entryLines("  one  ")).toEqual(["  one  "]);
  });

  test("has nothing to say about empty text", () => {
    expect(entryLines("")).toEqual([]);
  });
});
