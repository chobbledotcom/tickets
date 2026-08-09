import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatProgressLine,
  formatSummaryLines,
  summarize,
} from "#scripts/mutation/summary.ts";
import { fakeResult } from "./fixtures.ts";

describe("scoring a mutation run", () => {
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

  test("formats survivor locations with project-relative paths", () => {
    const lines = formatSummaryLines(
      summarize([
        fakeResult("survived", 12, "return value", "return undefined"),
      ]),
    );

    expect(lines.join("\n")).toContain("src/example.ts:12:3");
    expect(lines.join("\n")).toContain("return value");
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
});
