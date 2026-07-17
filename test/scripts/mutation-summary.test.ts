import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withEnv } from "#test-utils/env.ts";
import { tempFile } from "#test-utils/files.ts";
import {
  formatProgressLine,
  formatSummaryLines,
  type MutantResult,
  rel,
  summarize,
  writeStepSummary,
} from "../../scripts/mutation/summary.ts";
import { projectRoot } from "../../scripts/project-root.ts";

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

  test("aggregates and formats phase timing work", async () => {
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
    expect(formatSummaryLines(summary).join("\n")).toContain(
      "direct-tests: 30ms in 2 run(s)",
    );
    using file = tempFile({ prefix: "mutation-timing-summary-" });
    const markdown = await withStepSummary(file.path, () =>
      writeStepSummary(summary),
    );
    expect(markdown).toContain("| integration-tests | 1 | 40ms |");
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

  test("writes GitHub step summaries when configured", async () => {
    using file = tempFile({ prefix: "mutation-summary-" });
    const text = await withStepSummary(file.path, () => {
      writeStepSummary(summarize([]));
      writeStepSummary(summarize([fakeResult("ignored", 1, "??", "||")]));
      writeStepSummary(
        summarize([
          fakeResult("killed", 2, "===", "!=="),
          fakeResult("ignored", 3, "??", "||"),
        ]),
      );
      writeStepSummary(
        summarize([fakeResult("survived", 4, "return x", "return undefined")]),
      );
    });

    expect(text).toContain("Inconclusive");
    expect(text).toContain("nothing killable");
    expect(text).toContain("All 1 mutants detected");
    expect(text).toContain("Survivors");
    expect(text).toContain("src/example.ts:4:3");
  });

  test("ignores absent or unwritable GitHub step summary paths", async () => {
    await withStepSummary(null, () => writeStepSummary(summarize([])));
    await withStepSummary("/tmp/missing-dir/mutation-summary.md", () =>
      writeStepSummary(summarize([fakeResult("killed", 1, "true", "false")])),
    );
  });
});
