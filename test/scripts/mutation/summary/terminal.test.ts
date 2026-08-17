import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatSummaryLines,
  type MutantResult,
  summarize,
} from "#scripts/mutation/summary.ts";
import { fakeResult, plain, timingSummary } from "./fixtures.ts";

describe("the terminal mutation report", () => {
  /** The terminal report as plain lines, with any colour codes removed. */
  const terminalLines = (results: MutantResult[]): string[] =>
    formatSummaryLines(summarize(results)).map(plain);

  test("calls a terminal run with nothing to mutate inconclusive", () => {
    expect(terminalLines([])).toEqual([
      "\nMutation testing summary",
      "  No mutable operators were found — nothing to mutate.",
      "  Result is INCONCLUSIVE (a mutation score needs ≥1 mutant).",
    ]);
  });

  test("tells the terminal when every mutant is a known-equivalent", () => {
    expect(terminalLines([fakeResult("ignored", 1, "??", "||")])).toEqual([
      "\nMutation testing summary",
      "  All 1 mutant(s) suppressed as known-equivalent — nothing killable.",
    ]);
  });

  test("lines the terminal counts up under their labels", () => {
    expect(
      terminalLines([
        fakeResult("killed", 1, "===", "!=="),
        fakeResult("killed", 2, "while", "(removed)"),
        fakeResult("ignored", 3, "??", "||"),
      ]),
    ).toEqual([
      "\nMutation testing summary",
      "  mutants:   3",
      "  killed:    2",
      "  survived:  0",
      "  ignored:   1",
      "  score:     100.0%  (detected 2/2, 1 suppressed)",
      "\nAll mutants were detected. (1 suppressed as known-equivalent)",
    ]);
  });

  test("lists the terminal survivors under their own heading", () => {
    expect(
      terminalLines([
        fakeResult("killed", 1, "===", "!=="),
        fakeResult("survived", 4, "return x", "return undefined"),
      ]),
    ).toEqual([
      "\nMutation testing summary",
      "  mutants:   2",
      "  killed:    1",
      "  survived:  1",
      "  score:     50.0%  (detected 1/2)",
      "\nSurvivors — these mutations did not fail any test:",
      "  src/example.ts:4:3\n    src/example.ts::fn4 return x→return undefined",
      "\n  Proven unkillable by any test? Paste its line above into a file" +
        " under scripts/mutation/equivalent-mutants/, followed by  # and the" +
        " reason.",
    ]);
  });

  test("formats phase timing work in terminal summaries", () => {
    expect(formatSummaryLines(timingSummary()).map(plain).slice(-5)).toEqual([
      "",
      "  phase timings (cumulative elapsed):",
      "    lint: 4ms in 1 run(s)",
      "    direct-tests: 10ms in 1 run(s)",
      "\nAll mutants were detected.",
    ]);
  });

  test("formats phase timing work when all mutants are ignored", () => {
    const terminal = formatSummaryLines(timingSummary("ignored")).join("\n");

    expect(terminal).toContain("phase timings (cumulative elapsed):");
    expect(terminal).toContain("direct-tests: 10ms in 1 run(s)");
  });

  test("formats inconclusive and all-ignored terminal summaries", () => {
    expect(formatSummaryLines(summarize([])).join("\n")).toContain(
      "INCONCLUSIVE",
    );
    expect(
      formatSummaryLines(
        summarize([fakeResult("ignored", 4, "??", "||")]),
      ).join("\n"),
    ).toContain("suppressed as known-equivalent");
  });

  test("formats detected terminal summaries with ignored counts", () => {
    const lines = formatSummaryLines(
      summarize([
        fakeResult("killed", 1, "===", "!=="),
        fakeResult("ignored", 2, "??", "||"),
      ]),
    ).join("\n");

    expect(lines).toContain("ignored:");
    expect(lines).toContain("All mutants were detected");
    expect(lines).toContain("1 suppressed as known-equivalent");
  });
});
