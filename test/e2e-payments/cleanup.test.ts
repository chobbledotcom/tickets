/** Direct tests for cleanup error aggregation and precedence. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { attemptEveryCleanup, cleanupErrorForScenario } from "#e2e/cleanup.ts";

describe("attempting every cleanup", () => {
  it("runs every step even when an early one fails", async () => {
    const ran: string[] = [];
    const outcome = await attemptEveryCleanup([
      {
        name: "first",
        run: async () => {
          ran.push("first");
          throw new Error("boom");
        },
      },
      {
        name: "second",
        run: async () => {
          ran.push("second");
        },
      },
      {
        name: "third",
        run: async () => {
          ran.push("third");
          throw new Error("bang");
        },
      },
    ]);
    expect(ran).toEqual(["first", "second", "third"]);
    expect(outcome.errors.map((e) => e.message)).toEqual([
      "cleanup of first failed: boom",
      "cleanup of third failed: bang",
    ]);
  });

  it("reports no errors when every step succeeds", async () => {
    const outcome = await attemptEveryCleanup([
      { name: "only", run: () => Promise.resolve() },
    ]);
    expect(outcome.errors).toEqual([]);
  });

  it("wraps a non-Error thrown value as a cleanup Error", async () => {
    const outcome = await attemptEveryCleanup([
      {
        name: "string-throw",
        run: async () => {
          throw "not an Error";
        },
      },
    ]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.message).toContain("string-throw");
    expect(outcome.errors[0]?.message).toContain("not an Error");
  });
});

describe("cleanup error precedence", () => {
  it("fails a passing scenario on any cleanup error", () => {
    const failure = cleanupErrorForScenario(
      { errors: [new Error("leak")] },
      false,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure?.message).toBe("scenario cleanup failed");
  });

  it("keeps a failed scenario's own error primary", () => {
    expect(
      cleanupErrorForScenario({ errors: [new Error("leak")] }, true),
    ).toBeNull();
    expect(cleanupErrorForScenario({ errors: [] }, true)).toBeNull();
    expect(cleanupErrorForScenario({ errors: [] }, false)).toBeNull();
  });
});
