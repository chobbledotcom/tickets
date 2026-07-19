import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { testFormParams } from "#test-utils/form-values.ts";

test("testFormParams appends repeated values and skips missing values", () => {
  const params = testFormParams({
    absent: undefined,
    empty: null,
    selected: ["first", "second"],
    single: "value",
  });

  expect([...params.entries()]).toEqual([
    ["selected", "first"],
    ["selected", "second"],
    ["single", "value"],
  ]);
});
