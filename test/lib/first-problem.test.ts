import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { firstProblem } from "#shared/first-problem.ts";

describe("firstProblem", () => {
  test("returns null when every item passes, having checked each in order", async () => {
    const checked: string[] = [];
    const result = await firstProblem(["one", "two", "three"], (item) => {
      checked.push(item);
      return null;
    });
    expect(result).toBe(null);
    expect(checked).toEqual(["one", "two", "three"]);
  });

  test("returns the first item's problem and stops there", async () => {
    const checked: string[] = [];
    const result = await firstProblem(["one", "two", "three"], (item) => {
      checked.push(item);
      return item === "two" ? `bad: ${item}` : null;
    });
    expect(result).toBe("bad: two");
    expect(checked).toEqual(["one", "two"]);
  });

  test("returns null for an empty list without calling the check", async () => {
    let called = false;
    const result = await firstProblem([], () => {
      called = true;
      return "never";
    });
    expect(result).toBe(null);
    expect(called).toBe(false);
  });
});
