/** What a run says when its whole-run guard stopped it part-way. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deadlineReport } from "#scripts/mutation/summary.ts";

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
    const lines = deadlineReport(1000, 0, 1);

    expect(lines.join(" ")).toContain("Nothing is scored");
  });

  test("points at the mutants after the last one reported", () => {
    const lines = deadlineReport(1000, 1, 2);

    expect(lines.join(" ")).toContain("loop forever");
    expect(lines.join(" ")).toContain("after the last one");
  });

  test("counts nothing to do as nothing tested", () => {
    expect(deadlineReport(50, 0, 0)[0]).toContain("0 of 0 mutants tested");
  });
});
