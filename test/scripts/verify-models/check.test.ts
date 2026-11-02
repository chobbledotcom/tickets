import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { requireCounterexample } from "#scripts/verify-models/check.ts";

describe("negative control evidence", () => {
  test("rejects an accepted corruption", () => {
    expect(() =>
      requireCounterexample(
        { output: "NoError", success: true },
        "lost money",
        "/proof",
        "tla",
      ),
    ).toThrow(/accepted lost money/);
  });

  test("rejects crashes and incomplete counterexample reports", () => {
    for (const output of [
      "Parsing error: Semantic errors.",
      "Safety is violated.",
      "Check the trace in: /proof/trace.itf.json",
    ]) {
      expect(() =>
        requireCounterexample(
          { output, success: false },
          "lost money",
          "/proof",
          "tla",
        ),
      ).toThrow(/no invariant violation and trace/);
    }
  });

  test("a Quint violation needs both the report and its example execution", () => {
    for (const output of [
      'An example execution:\n\n[State 0] { bookingState: "active" }\n\n[ok] No violation found',
      "[violation] Found an issue (8ms at 250 traces/second).",
    ]) {
      expect(() =>
        requireCounterexample(
          { output, success: false },
          "a changed historical assessment",
          "/proof",
          "quint",
        ),
      ).toThrow(/no invariant violation and trace/);
    }
    expect(() =>
      requireCounterexample(
        {
          output:
            "An example execution:\n\n[State 0] { allAttemptsSafe: true }\n\n[State 1] { allAttemptsSafe: false }\n\n[violation] Found an issue",
          success: false,
        },
        "a changed historical assessment",
        "/proof",
        "quint",
      ),
    ).not.toThrow();
  });
});
