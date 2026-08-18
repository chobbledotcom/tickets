import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { range } from "#fp";

describe("range", () => {
  test("counts up from start, stopping before end", () => {
    expect(range(0, 3)).toEqual([0, 1, 2]);
    expect(range(1, 5)).toEqual([1, 2, 3, 4]);
  });

  test("crosses zero without skipping", () => {
    expect(range(-2, 2)).toEqual([-2, -1, 0, 1]);
  });

  test("is empty when end is not past start", () => {
    expect(range(2, 2)).toEqual([]);
    expect(range(3, 1)).toEqual([]);
  });
});
