import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { summarizePr } from "../../../scripts/pr-queue/summary.ts";
import { checkRun, makePr } from "./fixtures.ts";

describe("summarizePr CI check classification", () => {
  test("failing checks fact lists every failing check name", () => {
    const s = summarizePr(makePr({ checks: { failing: ["a", "b", "c"] } }));
    expect(s.bucket).toBe("ATTENTION");
    expect(s.facts).toEqual(["has failing checks (a, b, c)"]);
  });

  describe("legacy commit statuses (context + state nodes)", () => {
    test("a failing legacy status needs attention and names it", () => {
      const s = summarizePr(
        makePr({
          checks: {
            passing: ["build"],
            statusContexts: { failing: ["deploy"] },
          },
        }),
      );
      expect(s.bucket).toBe("ATTENTION");
      expect(s.facts).toEqual(["has failing checks (deploy)"]);
    });

    test("an errored legacy status is treated as a failure", () => {
      const s = summarizePr(
        makePr({
          checks: { passing: ["build"], statusContexts: { error: ["deploy"] } },
        }),
      );
      expect(s.bucket).toBe("ATTENTION");
      expect(s.facts).toEqual(["has failing checks (deploy)"]);
    });

    test("a pending legacy status waits and names it", () => {
      const s = summarizePr(
        makePr({
          checks: { passing: ["build"], statusContexts: { pending: ["ci"] } },
        }),
      );
      expect(s.bucket).toBe("WAITING");
      expect(s.facts).toEqual(["has checks still running (ci)"]);
    });

    test("a passing legacy status is neither failing nor pending", () => {
      const s = summarizePr(
        makePr({
          checks: {
            passing: ["build"],
            statusContexts: { passing: ["deploy"] },
          },
        }),
      );
      expect(s.bucket).toBe("READY");
      expect(s.facts).toEqual([
        "is ready to merge — all checks pass, no open comments",
      ]);
    });
  });

  describe("completed check-run conclusions", () => {
    // GitHub counts only SUCCESS / SKIPPED / NEUTRAL as a passing required
    // check; every other terminal conclusion blocks the merge and must read as
    // failing so a broken PR is never printed as ready.
    for (const conclusion of [
      "FAILURE",
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "CANCELLED",
      "STALE",
    ]) {
      test(`a ${conclusion} check run is a failure`, () => {
        const s = summarizePr(
          makePr({
            checks: {
              nodes: [checkRun("deploy", "COMPLETED", conclusion)],
              passing: ["build"],
            },
          }),
        );
        expect(s.bucket).toBe("ATTENTION");
        expect(s.facts).toEqual(["has failing checks (deploy)"]);
      });
    }

    for (const conclusion of ["SKIPPED", "NEUTRAL"]) {
      test(`a ${conclusion} check run does not block the merge`, () => {
        const s = summarizePr(
          makePr({
            checks: {
              nodes: [checkRun("lint", "COMPLETED", conclusion)],
              passing: ["build"],
            },
          }),
        );
        expect(s.bucket).toBe("READY");
        expect(s.facts).toEqual([
          "is ready to merge — all checks pass, no open comments",
        ]);
      });
    }
  });

  test("an unrecognised rollup node shape is dropped", () => {
    const s = summarizePr(
      makePr({
        checks: { nodes: [{ unrecognized: true }], passing: ["build"] },
      }),
    );
    expect(s.bucket).toBe("READY");
    expect(s.facts).toEqual([
      "is ready to merge — all checks pass, no open comments",
    ]);
  });
});
