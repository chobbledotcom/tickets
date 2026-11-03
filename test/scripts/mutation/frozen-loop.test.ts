/** What a run says when a test batch outlives its limit: a cause, not a score. */

import { assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  type FrozenLoop,
  frozenLoopReport,
} from "#scripts/mutation/summary.ts";

const loop: FrozenLoop = {
  batch: ["test/shared/example.test.ts"],
  durationMs: 92_500,
  file: "/work/src/shared/example.ts",
  limitMs: 60_000,
  mutant: {
    anchor: "step",
    column: 7,
    end: 12,
    line: 4,
    newOperator: "0",
    operator: "1",
    start: 6,
  },
};

describe("the frozen loop report", () => {
  test("names the mutant whose text froze the tests", () => {
    const lines = frozenLoopReport(loop, 1, 4);

    assertStringIncludes(lines[1] ?? "", "example.ts:4:7");
    assertStringIncludes(lines[1] ?? "", "1 -> 0");
  });

  test("names the batch that outlived the limit and for how long", () => {
    const lines = frozenLoopReport(loop, 1, 4).join("\n");

    assertStringIncludes(lines, "test/shared/example.test.ts");
    assertStringIncludes(lines, "It ran for 92500ms");
    assertStringIncludes(lines, "The limit is 60000ms");
  });

  test("says how far the run got before it stopped", () => {
    const headline = frozenLoopReport(loop, 1, 4)[0] ?? "";

    assertStringIncludes(headline, "passed the limit");
    assertStringIncludes(headline, "1 of 4 mutants tested");
  });

  test("says a clock never gave the mutant a verdict", () => {
    // The whole point of the guard: it stops the run and scores nothing. A
    // reader must not take the stop as evidence about this mutant.
    const lines = frozenLoopReport(loop, 1, 4).join(" ");

    assertStringIncludes(lines, "No mutant is judged by a clock");
    assertStringIncludes(lines, "has no score");
  });

  test("points at the loop the mutant froze", () => {
    assertStringIncludes(
      frozenLoopReport(loop, 1, 4).join(" "),
      "Make that loop bounded",
    );
  });
});
