import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { splitFlagValues } from "#scripts/flag-values.ts";

describe("splitFlagValues", () => {
  test("keeps every argument that is not the flag, in order", () => {
    expect(splitFlagValues(["a", "--other", "b"], "--flag")).toEqual({
      rest: ["a", "--other", "b"],
      values: [],
    });
  });

  test("collects each value of a repeated flag", () => {
    expect(
      splitFlagValues(["--flag", "one", "mid", "--flag", "two"], "--flag"),
    ).toEqual({ rest: ["mid"], values: ["one", "two"] });
  });

  test("yields undefined for a flag with nothing after it", () => {
    expect(splitFlagValues(["a", "--flag"], "--flag")).toEqual({
      rest: ["a"],
      values: [undefined],
    });
  });
});
