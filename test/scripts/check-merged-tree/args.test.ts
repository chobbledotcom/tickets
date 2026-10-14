import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseArgs, usageLine } from "#scripts/check-merged-tree/args.ts";

describe("merged-tree check arguments", () => {
  test("treats a numeric argument as a pull request into main", () => {
    expect(parseArgs(["2583"])).toEqual({
      kind: "ok",
      parsed: { base: "main", head: { kind: "pr", number: 2583 } },
    });
  });

  test("treats a named argument as a branch into main", () => {
    expect(parseArgs(["feature/x"])).toEqual({
      kind: "ok",
      parsed: { base: "main", head: { kind: "ref", name: "feature/x" } },
    });
  });

  test("accepts a branch and base pair", () => {
    expect(parseArgs(["feature/x", "release-1"])).toEqual({
      kind: "ok",
      parsed: { base: "release-1", head: { kind: "ref", name: "feature/x" } },
    });
  });

  test("strips an origin prefix from both names", () => {
    expect(parseArgs(["origin/feature/x", "origin/main"])).toEqual({
      kind: "ok",
      parsed: { base: "main", head: { kind: "ref", name: "feature/x" } },
    });
  });

  test("rejects a base paired with a pull request number", () => {
    expect(parseArgs(["2583", "main"])).toEqual({
      kind: "usage",
      message:
        "A pull request number merges into main. Pass a branch to choose the base.",
    });
  });

  test("rejects an empty argument list", () => {
    expect(parseArgs([])).toEqual({ kind: "usage", message: usageLine });
  });

  test("rejects more than two arguments", () => {
    expect(parseArgs(["a", "b", "c"])).toEqual({
      kind: "usage",
      message: usageLine,
    });
  });

  test("rejects a bare origin prefix as the head", () => {
    expect(parseArgs(["origin/"])).toEqual({
      kind: "usage",
      message: usageLine,
    });
  });

  test("rejects a bare origin prefix as the base", () => {
    expect(parseArgs(["feature/x", "origin/"])).toEqual({
      kind: "usage",
      message: usageLine,
    });
  });
});
