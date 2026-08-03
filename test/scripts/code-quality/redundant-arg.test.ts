import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findRedundantArg,
  type Site,
} from "#test/scripts/code-quality/detectors.ts";

describe("findRedundantArg", () => {
  const site = (args: string[], line = 1, file = "a.ts"): Site => ({
    args,
    file,
    line,
  });

  test("ignores built-in callees like padStart", () => {
    const sites = [site(["2", "'0'"]), site(["2", "'0'"]), site(["2", "'0'"])];
    expect(findRedundantArg("padStart", sites)).toBe(null);
  });

  test("ignores the built-in at(-1) last-element idiom", () => {
    const sites = [site(["-1"]), site(["-1"]), site(["-1"])];
    expect(findRedundantArg("at", sites)).toBe(null);
  });

  test("ignores callees with fewer than three call sites", () => {
    expect(findRedundantArg("foo", [site(["1"]), site(["1"])])).toBe(null);
  });

  test("flags a position that is always the same constant", () => {
    const sites = [
      site(["1"], 10, "a.ts"),
      site(["1"], 20, "b.ts"),
      site(["1"], 30, "c.ts"),
    ];
    expect(findRedundantArg("foo", sites)).toBe(
      "foo() arg #0 is always 1 across 3 calls (a.ts:10, b.ts:20, c.ts:30) — use a default parameter or constant",
    );
  });

  test("respects the allowed-constant-args list (parseInt radix)", () => {
    const sites = [site(["x", "10"]), site(["y", "10"]), site(["z", "10"])];
    expect(findRedundantArg("parseInt", sites)).toBe(null);
  });

  test("does not flag a position holding non-literal arguments", () => {
    const sites = [site(["a"]), site(["b"]), site(["c"])];
    expect(findRedundantArg("foo", sites)).toBe(null);
  });

  test("does not flag constants that differ across call sites", () => {
    const sites = [site(["1"]), site(["2"]), site(["3"])];
    expect(findRedundantArg("foo", sites)).toBe(null);
  });

  test("checks later positions when an earlier one varies", () => {
    const sites = [
      site(["a", "9"], 1, "a.ts"),
      site(["b", "9"], 2, "a.ts"),
      site(["c", "9"], 3, "a.ts"),
    ];
    expect(findRedundantArg("foo", sites)).toBe(
      "foo() arg #1 is always 9 across 3 calls (a.ts:1, a.ts:2, a.ts:3) — use a default parameter or constant",
    );
  });

  test("only inspects positions present in every call site", () => {
    // Shared arity is 1 (the second site stops after arg #0), so the constant
    // `"9"` at position #1 of the two wider sites is never inspected. Position
    // #0 varies across all three sites, so nothing is flagged — proving a
    // position absent from any call site is ignored even when other positions
    // happen to be constant across the wider ones.
    const sites = [site(["a", "9"]), site(["b"]), site(["c", "9"])];
    expect(findRedundantArg("foo", sites)).toBe(null);
  });

  test("appends an ellipsis when there are more than four call sites", () => {
    const sites = [
      site(["1"], 1, "f1.ts"),
      site(["1"], 1, "f2.ts"),
      site(["1"], 1, "f3.ts"),
      site(["1"], 1, "f4.ts"),
      site(["1"], 1, "f5.ts"),
    ];
    expect(findRedundantArg("foo", sites)).toBe(
      "foo() arg #0 is always 1 across 5 calls (f1.ts:1, f2.ts:1, f3.ts:1, f4.ts:1, ...) — use a default parameter or constant",
    );
  });
});
