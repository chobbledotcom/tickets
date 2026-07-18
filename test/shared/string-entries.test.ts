import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stringEntries } from "#shared/string-entries.ts";

test("stringEntries keeps string values and their keys", () => {
  expect(
    stringEntries([
      ["name", "Alice"],
      ["count", 2],
      ["empty", ""],
      ["missing", null],
    ]),
  ).toEqual([
    ["name", "Alice"],
    ["empty", ""],
  ]);
});
