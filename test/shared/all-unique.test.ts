/** The duplicate-key guard: a record holds each key once, and a list that
 * repeats one of its own values must be refused. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { allUnique } from "#shared/all-unique.ts";

describe("allUnique", () => {
  test("is true when every value appears once", () => {
    expect(allUnique(["a", "b", "c"])).toBe(true);
    expect(allUnique([1, 2, 3])).toBe(true);
  });

  test("is false when any value repeats", () => {
    expect(allUnique(["a", "b", "a"])).toBe(false);
    expect(allUnique([7, 7])).toBe(false);
  });

  test("is true for a list with no values", () => {
    expect(allUnique([])).toBe(true);
  });

  test("tells values apart by identity, not by shape", () => {
    const one = { id: 1 };
    expect(allUnique([one, { id: 1 }])).toBe(true);
    expect(allUnique([one, one])).toBe(false);
  });
});
