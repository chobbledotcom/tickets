import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stringEntries } from "#shared/string-entries.ts";

test("stringEntries keeps string values in iterable order", () => {
  const entries = new Map<number, unknown>([
    [2, "second"],
    [1, "first"],
  ]);

  expect(stringEntries(entries)).toEqual([
    [2, "second"],
    [1, "first"],
  ]);
});

test("stringEntries keeps empty strings", () => {
  expect(stringEntries([["empty", ""]])).toEqual([["empty", ""]]);
});

test("stringEntries drops non-string values", () => {
  expect(
    stringEntries([
      ["null", null],
      ["undefined", undefined],
      ["number", 0],
      ["boolean", false],
      ["bigint", 0n],
      ["symbol", Symbol("value")],
      ["object", {}],
      ["array", []],
    ]),
  ).toEqual([]);
});
