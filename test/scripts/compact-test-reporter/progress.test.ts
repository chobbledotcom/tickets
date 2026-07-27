import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CompactTapReporter } from "#scripts/compact-test-reporter.ts";

/** Run lines through a reporter and hand back what it printed as passes. */
const passes = (lines: string[], estimatedTotal?: number): string[] => {
  const out: string[] = [];
  const reporter = new CompactTapReporter({
    cwd: Deno.cwd(),
    estimatedTotal,
    stdout: (line) => out.push(line),
  });
  for (const line of lines) reporter.consumeLine(line);
  reporter.finish();
  return out;
};

describe("the progress indicator", () => {
  test("treats the first test as the whole run until told otherwise", () => {
    expect(passes(["ok 1 - first"])).toEqual([
      "ok   [########################] 1/1 first",
    ]);
  });

  test("shows at least one filled block for the very first test", () => {
    expect(passes(["ok 1 - first"], 100)).toEqual([
      "ok   [#-----------------------]   1/100 first",
    ]);
  });

  test("lines the count up with the width of the total", () => {
    expect(passes(["ok 1 - first"], 10)).toEqual([
      "ok   [##----------------------]  1/10 first",
    ]);
  });

  test("fills the bar completely on the last test", () => {
    expect(passes(["ok 1 - first", "ok 2 - second"], 2)[1]).toBe(
      "ok   [########################] 2/2 second",
    );
  });

  test("takes the total from a plan line", () => {
    expect(passes(["1..4", "ok 1 - first"])).toEqual([
      "ok   [######------------------] 1/4 first",
    ]);
  });
});

describe("noticing that the run really is TAP output", () => {
  const sawTap = (lines: string[]): boolean => {
    const reporter = new CompactTapReporter({
      cwd: Deno.cwd(),
      hideProgress: true,
      stdout: () => {},
    });
    for (const line of lines) reporter.consumeLine(line);
    return reporter.finish().sawTap;
  };

  test("is false for output with no TAP in it", () => {
    expect(sawTap(["Download https://example.com/mod.ts", ""])).toBe(false);
  });

  test("is true after the TAP version header", () => {
    expect(sawTap(["TAP version 14"])).toBe(true);
  });

  test("is true after a plan line", () => {
    expect(sawTap(["1..2"])).toBe(true);
  });

  test("is true after a result line", () => {
    expect(sawTap(["ok 1 - first"])).toBe(true);
  });
});
