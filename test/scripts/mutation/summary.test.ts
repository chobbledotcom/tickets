import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatProgressLine,
  formatSummaryLines,
  type MutantResult,
  rel,
  summarize,
  writeStepSummary,
} from "#scripts/mutation/summary.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { withEnv } from "#test-utils/env.ts";
import { tempFile } from "#test-utils/files.ts";

const fakeResult = (
  status: MutantResult["status"],
  line: number,
  operator: string,
  newOperator: string,
  file = `${projectRoot}/src/example.ts`,
): MutantResult => ({
  detectedBy: status === "killed" ? "direct-tests" : null,
  file,
  mutant: {
    column: 3,
    end: 1,
    line,
    newOperator,
    operator,
    start: 0,
  },
  status,
  timings: [],
});

describe("mutation summary", () => {
  const withStepSummary = async (
    path: string | null,
    run: () => void,
  ): Promise<string> => {
    using _env = withEnv({ GITHUB_STEP_SUMMARY: path ?? undefined });
    run();
    return path === null ? "" : await Deno.readTextFile(path).catch(() => "");
  };

  const timingSummary = (status: MutantResult["status"] = "killed") => {
    const result = fakeResult(status, 1, "true", "false");
    result.timings = [
      { durationMs: 4, phase: "lint" },
      { durationMs: 10, phase: "direct-tests" },
    ];
    return summarize([result]);
  };

  test("excludes ignored equivalent survivors from the score denominator", () => {
    const summary = summarize([
      fakeResult("killed", 1, "===", "!="),
      fakeResult("timed-out", 2, "while", "(removed)"),
      fakeResult("survived", 3, "true", "false"),
      fakeResult("ignored", 4, "??", "||"),
    ]);

    expect(summary).toMatchObject({
      detected: 2,
      effective: 3,
      ignored: 1,
      killed: 1,
      phaseTimings: [],
      survived: 1,
      timedOut: 1,
      total: 4,
    });
    expect(summary.score).toBeCloseTo(66.666, 2);
  });

  test("aggregates phase timing work", () => {
    const first = fakeResult("killed", 1, "true", "false");
    first.timings = [
      { durationMs: 4, phase: "lint" },
      { durationMs: 10, phase: "direct-tests" },
    ];
    const second = fakeResult("survived", 2, "false", "true");
    second.timings = [
      { durationMs: 6, phase: "lint" },
      { durationMs: 20, phase: "direct-tests" },
      { durationMs: 40, phase: "integration-tests" },
    ];
    const summary = summarize([first, second]);
    expect(summary.phaseTimings).toEqual([
      { durationMs: 10, phase: "lint", runs: 2 },
      { durationMs: 30, phase: "direct-tests", runs: 2 },
      { durationMs: 40, phase: "integration-tests", runs: 1 },
    ]);
  });

  test("formats phase timing work in terminal summaries", () => {
    expect(formatSummaryLines(timingSummary()).join("\n")).toContain(
      "direct-tests: 10ms in 1 run(s)",
    );
  });

  test("writes phase timing work in Markdown summaries", async () => {
    using file = tempFile({ prefix: "mutation-timing-summary-" });
    const markdown = await withStepSummary(file.path, () =>
      writeStepSummary(timingSummary()),
    );
    expect(markdown).toContain("| direct-tests | 1 | 10ms |");
  });

  test("formats phase timing work when all mutants are ignored", () => {
    const terminal = formatSummaryLines(timingSummary("ignored")).join("\n");

    expect(terminal).toContain("phase timings (cumulative elapsed):");
    expect(terminal).toContain("direct-tests: 10ms in 1 run(s)");
  });

  test("writes phase timing work when all mutants are ignored", async () => {
    using file = tempFile({ prefix: "mutation-ignored-timing-summary-" });
    const markdown = await withStepSummary(file.path, () =>
      writeStepSummary(timingSummary("ignored")),
    );

    expect(markdown).toContain("### Phase timings");
    expect(markdown).toContain("| direct-tests | 1 | 10ms |");
  });

  test("summarizes an empty result as an inconclusive perfect denominator", () => {
    expect(summarize([])).toMatchObject({
      detected: 0,
      effective: 0,
      ignored: 0,
      killed: 0,
      score: 100,
      survived: 0,
      survivors: [],
      timedOut: 0,
      total: 0,
    });
  });

  test("keeps relative paths unchanged", () => {
    expect(rel("src/example.ts")).toBe("src/example.ts");
  });

  test("formats survivor locations with project-relative paths", () => {
    const lines = formatSummaryLines(
      summarize([
        fakeResult("survived", 12, "return value", "return undefined"),
      ]),
    );

    expect(lines.join("\n")).toContain("src/example.ts:12:3");
    expect(lines.join("\n")).toContain("return value");
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

  test("formats plain progress lines with counts and the latest mutation", () => {
    const last = fakeResult("survived", 9, "?:", "arms swapped");

    expect(
      formatProgressLine({
        completed: 7,
        ignored: 1,
        killed: 5,
        last,
        survived: 1,
        timedOut: 0,
        total: 20,
      }),
    ).toBe(
      "Mutation progress: 7/20 (35.0%); killed 5; survived 1; timed out 0; " +
        "ignored 1; last survived src/example.ts:9:3 ?: -> arms swapped",
    );
  });

  test("formats zero-total progress as complete", () => {
    expect(
      formatProgressLine({
        completed: 0,
        ignored: 0,
        killed: 0,
        last: fakeResult("killed", 1, "true", "false", "outside.ts"),
        survived: 0,
        timedOut: 0,
        total: 0,
      }),
    ).toContain("0/0 (100.0%)");
  });

  /** The Markdown one writeStepSummary call appended. */
  const stepSummary = async (results: MutantResult[]): Promise<string> => {
    using file = tempFile({ prefix: "mutation-summary-" });
    return await withStepSummary(file.path, () =>
      writeStepSummary(summarize(results)),
    );
  };

  test("calls a run with nothing to mutate inconclusive", async () => {
    expect(await stepSummary([])).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u26a0\ufe0f **Inconclusive** \u2014 no mutable operators were found, so nothing was" +
          " mutated. A mutation score needs at least one mutant.",
        "",
      ].join("\n"),
    );
  });

  test("says so when every mutant is a known-equivalent", async () => {
    expect(await stepSummary([fakeResult("ignored", 1, "??", "||")])).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u2705 All 1 mutant(s) suppressed as known-equivalent \u2014 nothing killable.",
        "",
      ].join("\n"),
    );
  });

  test("counts the mutants and notes the suppressed ones", async () => {
    expect(
      await stepSummary([
        fakeResult("killed", 2, "===", "!=="),
        fakeResult("ignored", 3, "??", "||"),
      ]),
    ).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u2705 **All 1 mutants detected** \u2014 score 100.0%, 1 suppressed",
        "",
        "| metric | count |",
        "| --- | --- |",
        "| mutants | 2 |",
        "| killed | 1 |",
        "| timed out | 0 |",
        "| survived | 0 |",
        "| ignored (suppressed) | 1 |",
        "",
      ].join("\n"),
    );
  });

  test("tables the survivors so a reviewer can see each one", async () => {
    expect(
      await stepSummary([
        fakeResult("killed", 1, "===", "!=="),
        fakeResult("survived", 4, "return x", "return undefined"),
      ]),
    ).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u274c **1 mutant(s) survived** \u2014 score 50.0% (detected 1/2)",
        "",
        "| metric | count |",
        "| --- | --- |",
        "| mutants | 2 |",
        "| killed | 1 |",
        "| timed out | 0 |",
        "| survived | 1 |",
        "",
        "### Survivors",
        "",
        "These mutations did not fail any test:",
        "",
        "| location | mutation |",
        "| --- | --- |",
        "| `src/example.ts:4:3` | `return x` \u2192 `return undefined` |",
        "",
      ].join("\n"),
    );
  });

  test("ignores absent or unwritable GitHub step summary paths", async () => {
    await withStepSummary(null, () => writeStepSummary(summarize([])));
    await withStepSummary("/tmp/missing-dir/mutation-summary.md", () =>
      writeStepSummary(summarize([fakeResult("killed", 1, "true", "false")])),
    );
  });
});
