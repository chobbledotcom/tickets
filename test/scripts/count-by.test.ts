import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { countBy } from "#scripts/count-by.ts";

describe("countBy", () => {
  test("counts every item under the key it reads", () => {
    expect(
      countBy((word: string) => word.slice(0, 1))(["ant", "ape", "bee"]),
    ).toEqual({ a: 2, b: 1 });
  });

  test("counts keys that share a name with a built-in object property", () => {
    const counts = countBy((word: string) => word)([
      "constructor",
      "__proto__",
      "toString",
      "toString",
    ]);
    expect(Object.entries(counts)).toEqual([
      ["constructor", 1],
      ["__proto__", 1],
      ["toString", 2],
    ]);
  });
});
