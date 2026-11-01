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
        ),
      ).toThrow(/no invariant violation and trace/);
    }
  });
});
