import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { CheckerResult } from "#scripts/verify-models/check.ts";
import type { ModelCheck } from "#scripts/verify-models/jobs.ts";
import { type PassStore, runChecks } from "#scripts/verify-models/run.ts";

const proof = (module: string): ModelCheck => ({
  directory: `/proof/${module}`,
  kind: "proof",
  module,
  phase: "initial",
});

const passed: CheckerResult = { output: "NoError", success: true };

/** A store that holds no pass and keeps none. */
const noPasses: PassStore = {
  known: () => Promise.resolve(false),
  record: () => Promise.resolve(),
};

/** Keeps each line that the queue logs. */
const logTo = (lines: string[]) =>
  stub(console, "log", (line: string) => {
    lines.push(line);
  });

const invalidOutcomes = [
  {
    check: proof("Broken"),
    name: "a failed clean proof",
    result: { output: "Invariant violated.", success: false },
  },
  {
    check: { ...proof("Broken"), kind: "control", name: "lost money" } as const,
    name: "an accepted corruption",
    result: passed,
  },
  {
    check: { ...proof("Broken"), kind: "control", name: "lost money" } as const,
    name: "a crashed negative control",
    result: { output: "Parser error.", success: false },
  },
];

describe("model check queue", () => {
  test("keeps two checks active and fills a free place before the other check ends", async () => {
    using _log = stub(console, "log", () => {});
    const checks: ModelCheck[] = [
      proof("First"),
      proof("Slow"),
      proof("Third"),
      { ...proof("Last"), kind: "control", name: "unsafe move" },
    ];
    const releases = checks.map(() => Promise.withResolvers<CheckerResult>());
    const starts = checks.map(() => Promise.withResolvers<void>());
    const events: string[] = [];
    const complete = runChecks(
      checks,
      (check) => {
        const index = checks.indexOf(check);
        events.push(check.module);
        starts[index]!.resolve();
        return releases[index]!.promise;
      },
      2,
      noPasses,
    );
    await starts[1]!.promise;
    expect(events).toEqual(["First", "Slow"]);

    releases[0]!.resolve(passed);
    await starts[2]!.promise;
    expect(events).toEqual(["First", "Slow", "Third"]);

    releases[2]!.resolve(passed);
    await starts[3]!.promise;
    expect(events).toEqual(["First", "Slow", "Third", "Last"]);
    releases[1]!.resolve(passed);
    releases[3]!.resolve({
      output:
        "Safety violated. Check the trace in: /proof/Last/violation.itf.json",
      success: false,
    });
    await complete;
  });

  for (const { check, result, name } of invalidOutcomes) {
    test(`stops queued work after ${name}`, async () => {
      using _log = stub(console, "log", () => {});
      const busy = Promise.withResolvers<CheckerResult>();
      const busyStarted = Promise.withResolvers<void>();
      const checks = [check, proof("Busy"), proof("Queued")];
      const started: string[] = [];
      const recorded: string[] = [];
      const complete = runChecks(
        checks,
        (current) => {
          started.push(current.module);
          if (current.module === "Broken") return Promise.resolve(result);
          busyStarted.resolve();
          return busy.promise;
        },
        2,
        {
          ...noPasses,
          record: (current) => {
            recorded.push(current.module);
            return Promise.resolve();
          },
        },
      );
      const rejection = expect(complete).rejects.toBeInstanceOf(Error);
      await busyStarted.promise;
      busy.resolve(passed);
      await rejection;
      expect(started).toEqual(["Broken", "Busy"]);
      expect(recorded).toEqual(["Busy"]);
    });
  }

  test("keeps three checks active for three workers", async () => {
    using _log = stub(console, "log", () => {});
    const checks = ["One", "Two", "Three", "Four"].map(proof);
    const release = Promise.withResolvers<CheckerResult>();
    const thirdStarted = Promise.withResolvers<void>();
    const started: string[] = [];
    const complete = runChecks(
      checks,
      (check) => {
        started.push(check.module);
        if (check.module === "Three") thirdStarted.resolve();
        return release.promise;
      },
      3,
      noPasses,
    );
    await thirdStarted.promise;
    expect(started).toEqual(["One", "Two", "Three"]);
    release.resolve(passed);
    await complete;
    expect(started).toEqual(["One", "Two", "Three", "Four"]);
  });

  test("does not run a check that passed before with the same inputs", async () => {
    const lines: string[] = [];
    using _log = logTo(lines);
    const started: string[] = [];
    const recorded: string[] = [];
    await runChecks(
      [proof("Known"), proof("Fresh")],
      (check) => {
        started.push(check.module);
        return Promise.resolve(passed);
      },
      2,
      {
        known: (check) => Promise.resolve(check.module === "Known"),
        record: (check) => {
          recorded.push(check.module);
          return Promise.resolve();
        },
      },
    );
    expect(started).toEqual(["Fresh"]);
    expect(recorded).toEqual(["Fresh"]);
    expect(lines).toContain(
      "Passed Known: initial state (same inputs as an earlier pass).",
    );
  });

  test("accepts a scope that the checker passes, under its own label", async () => {
    const lines: string[] = [];
    using _log = logTo(lines);
    await runChecks(
      [{ ...proof("Kept"), kind: "scope", name: "one wrong amount" }],
      () => Promise.resolve(passed),
      2,
      noPasses,
    );
    expect(lines[0]).toBe("Check Kept: one wrong amount scope.");
  });

  test("refuses a scope that the checker does not pass", async () => {
    using _log = stub(console, "log", () => {});
    await expect(
      runChecks(
        [{ ...proof("Kept"), kind: "scope", name: "one wrong amount" }],
        () =>
          Promise.resolve({ output: "Invariant violated.", success: false }),
        2,
        noPasses,
      ),
    ).rejects.toThrow(
      "Kept scope of one wrong amount failed. Read /proof/Kept.\nInvariant violated.",
    );
  });

  test("propagates a process failure and stops the queued work", async () => {
    using _log = stub(console, "log", () => {});
    const failure = new Error("The checker could not start.");
    const busy = Promise.withResolvers<CheckerResult>();
    const started: string[] = [];
    const complete = runChecks(
      [proof("Broken"), proof("Busy"), proof("Queued")],
      (check) => {
        started.push(check.module);
        if (check.module === "Broken") throw failure;
        return busy.promise;
      },
      2,
      noPasses,
    );
    const rejection = expect(complete).rejects.toBe(failure);
    busy.resolve(passed);
    await rejection;
    expect(started).toEqual(["Broken", "Busy"]);
  });
});
