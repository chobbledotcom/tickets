import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { CheckerResult } from "#scripts/verify-models/check.ts";
import type { ModelCheck } from "#scripts/verify-models/jobs.ts";
import { runChecks } from "#scripts/verify-models/run.ts";

const proof = (module: string): ModelCheck => ({
  directory: `/proof/${module}`,
  kind: "proof",
  module,
  phase: "initial",
});

const passed: CheckerResult = { output: "NoError", success: true };

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
    const complete = runChecks(checks, (check) => {
      const index = checks.indexOf(check);
      events.push(check.module);
      starts[index]!.resolve();
      return releases[index]!.promise;
    });
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
      const complete = runChecks(checks, (current) => {
        started.push(current.module);
        if (current.module === "Broken") return Promise.resolve(result);
        busyStarted.resolve();
        return busy.promise;
      });
      const rejection = expect(complete).rejects.toBeInstanceOf(Error);
      await busyStarted.promise;
      busy.resolve(passed);
      await rejection;
      expect(started).toEqual(["Broken", "Busy"]);
    });
  }

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
    );
    const rejection = expect(complete).rejects.toBe(failure);
    busy.resolve(passed);
    await rejection;
    expect(started).toEqual(["Broken", "Busy"]);
  });
});
