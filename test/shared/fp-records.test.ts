import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refusalOf, withoutKey, withoutKeys } from "#shared/fp-records.ts";

describe("record helpers", () => {
  test("refusalOf builds a function that throws its message", () => {
    expect(refusalOf("No such row")).toThrow("No such row");
  });

  test("withoutKey leaves out the one key and keeps the rest", () => {
    expect(withoutKey("secret")({ id: 1, secret: "x" })).toEqual({ id: 1 });
  });

  test("withoutKeys leaves out each key of the set and keeps the rest", () => {
    const strip = withoutKeys(new Set(["a", "c", "absent"]));

    expect(strip({ a: 1, b: 2, c: 3 })).toEqual({ b: 2 });
    expect(withoutKeys(new Set())({ a: 1 })).toEqual({ a: 1 });
  });
});
