/** What a run says when its whole-run guard stopped it part-way. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deadlineReport, unfinishedRun } from "#scripts/mutation/summary.ts";

const ended = (
  state: { aborted: boolean; hitDeadline: boolean },
  tested = 0,
  total = 0,
) => unfinishedRun(state, { deadline: 1000, tested, total });

describe("the whole-run deadline report", () => {
  test("names how much of the run was answered before it stopped", () => {
    const lines = deadlineReport(1000, 2, 4);

    expect(lines[0]).toContain("1000ms deadline");
    expect(lines[0]).toContain("2 of 4 mutants tested");
  });

  test("says plainly that a stopped run scores nothing", () => {
    // The whole point of the guard: a run that ended early must not leave
    // anyone with a number, because the mutants it never reached are exactly
    // the ones nothing is known about.
    expect(deadlineReport(1000, 0, 1).join(" ")).toContain("Nothing is scored");
  });

  test("points at the mutants after the last one reported", () => {
    const lines = deadlineReport(1000, 1, 2).join(" ");

    expect(lines).toContain("loop forever");
    expect(lines).toContain("after the last one");
  });

  test("says so plainly when it stopped before there was a mutant to test", () => {
    // "0 of 0 mutants tested" would read as though there had been no work.
    expect(deadlineReport(50, 0, 0)[0]).toContain(
      "before it had a mutant to test",
    );
  });

  test("counts the mutant that was still running when the guard fired", () => {
    // The boundary against the case above: a mutant was planned and was
    // mid-flight, so it is the one that hung. Reporting "before it had a
    // mutant to test" here would hide the very thing the report points at.
    expect(deadlineReport(50, 0, 1)[0]).toContain("0 of 1 mutants tested");
  });
});

describe("how a run ended", () => {
  test("lets a finished run publish its score", () => {
    expect(ended({ aborted: false, hitDeadline: false }, 4, 4)).toBeNull();
  });

  test("fails a run its guard stopped, rather than scoring it", () => {
    const end = ended({ aborted: true, hitDeadline: true }, 2, 4);

    expect(end?.code).toBe(1);
    expect(end?.lines.join(" ")).toContain("deadline");
  });

  // Regression: the guard aborts the run, so by the time anything asks, the
  // run looks interrupted too. Reading it as an interrupt reported someone
  // pressing Ctrl-C and exited 130 — wrong code, wrong story. This shows up
  // wherever a run can end early, the baseline included, where nothing has
  // been tested yet.
  test("calls it a deadline even though the guard also aborted the run", () => {
    const end = ended({ aborted: true, hitDeadline: true });

    expect(end?.code).toBe(1);
    expect(end?.lines.join(" ")).not.toContain("Interrupted");
  });

  test("still reports an operator's interrupt as an interrupt", () => {
    const end = ended({ aborted: true, hitDeadline: false }, 1, 4);

    expect(end?.code).toBe(130);
    expect(end?.lines.join(" ")).toContain("Interrupted");
  });
});
