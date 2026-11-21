import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BASELINE_FILE_LIMIT_MS,
  type BaselineDeps,
  type BaselineOptions,
  timeTestFiles,
  verifyGroupedRuns,
} from "#scripts/mutation/baseline.ts";
import type {
  TestRunConfig,
  TestRunResult,
} from "#scripts/mutation/execution.ts";
import { type TimedTest, timeLimit } from "#scripts/mutation/plan.ts";

type Call = Readonly<{ config: TestRunConfig; signal: AbortSignal }>;

const options = (changes: Partial<BaselineOptions> = {}): BaselineOptions => ({
  batchJobs: 2,
  env: { STRIPE_MOCK_PORT: "12111" },
  signal: new AbortController().signal,
  ...changes,
});

const deps = (
  runTest: (
    config: TestRunConfig,
    signal: AbortSignal,
  ) => Promise<TestRunResult>,
): BaselineDeps => ({ runTest });

const passing = (): TestRunResult => ({ durationMs: 1, outcome: "passed" });

const failed = (output = "boom"): TestRunResult => ({
  durationMs: 1,
  failure: { batch: ["test/a.test.ts"], output },
  outcome: "failed",
});

const frozen = (limitMs = 5): TestRunResult => ({
  durationMs: 1,
  frozen: { batch: ["test/a.test.ts"], durationMs: 9, limitMs },
  outcome: "cancelled",
});

const cancelled = (): TestRunResult => ({
  durationMs: 1,
  outcome: "cancelled",
});

describe("timing the unmutated files", () => {
  test("runs every file on its own and keeps each time", async () => {
    const calls: Call[] = [];
    const signal = new AbortController().signal;
    const measured = await timeTestFiles(
      ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
      options({ signal }),
      deps((config, callSignal) => {
        calls.push({ config, signal: callSignal });
        return Promise.resolve(passing());
      }),
    );

    expect(measured.status).toBe("passed");
    if (measured.status !== "passed") throw new Error("Expected a pass");
    expect(calls.map(({ config }) => config.testFiles).toSorted()).toEqual([
      ["test/a.test.ts"],
      ["test/b.test.ts"],
      ["test/c.test.ts"],
    ]);
    expect(
      calls.map(({ config }) => [config.batchJobs, config.limitMs, config.env]),
    ).toEqual(
      Array.from({ length: 3 }, () => [
        1,
        BASELINE_FILE_LIMIT_MS,
        options().env,
      ]),
    );
    expect(calls.every((call) => call.signal === signal)).toBe(true);
    expect(measured.result.timings.map(({ file }) => file)).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
      "test/c.test.ts",
    ]);
    expect(measured.result.timings.every(({ ms }) => ms >= 0)).toBe(true);
  });

  test("stops on a failed file and keeps its output", async () => {
    const measured = await timeTestFiles(
      ["test/a.test.ts"],
      options(),
      deps(() => Promise.resolve(failed("not ok 1"))),
    );

    expect(measured).toEqual({
      failure: {
        message: "Unmutated test/a.test.ts failed.",
        output: "not ok 1",
      },
      status: "failed",
    });
  });

  test("names a file that ran past its limit or was cancelled", async () => {
    const cases = [
      [
        frozen(600_000),
        "Unmutated test/a.test.ts ran past its 600000ms limit.",
      ],
      [cancelled(), "Unmutated test/a.test.ts was cancelled before it passed."],
    ] as const;
    for (const [result, message] of cases) {
      const measured = await timeTestFiles(
        ["test/a.test.ts"],
        options(),
        deps(() => Promise.resolve(result)),
      );
      expect(measured).toEqual({
        failure: { message },
        status: "failed",
      });
    }
  });
});

describe("checking a plan's grouped runs", () => {
  const fastA = { file: "test/a.test.ts", ms: 100 };
  const fastB = { file: "test/b.test.ts", ms: 200 };
  const timings: readonly TimedTest[] = [
    fastA,
    fastB,
    { file: "test/c.test.ts", ms: 5_000 },
  ];

  test("runs each shared group once, with that group's own limit", async () => {
    const calls: Call[] = [];
    const failures = await verifyGroupedRuns(
      [
        ["test/a.test.ts", "test/b.test.ts"],
        ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
        ["test/c.test.ts"],
      ],
      timings,
      options(),
      deps((config, signal) => {
        calls.push({ config, signal });
        return Promise.resolve(passing());
      }),
    );

    expect(failures).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config.testFiles).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
    expect(calls[0]?.config.limitMs).toBe(
      timeLimit({ files: ["test/a.test.ts", "test/b.test.ts"], ms: 300 }),
    );
    expect(calls[0]?.config.batchJobs).toBe(2);
  });

  test("reports a shared group that does not pass together", async () => {
    const failures = await verifyGroupedRuns(
      [["test/a.test.ts", "test/b.test.ts"]],
      timings,
      options(),
      deps(() => Promise.resolve(failed("first test failed"))),
    );

    expect(failures).toEqual([
      {
        message: "Unmutated run of the 2 fast files together failed.",
        output: "first test failed",
      },
    ]);
  });

  test("runs nothing when every plan holds one file", async () => {
    let calls = 0;
    const failures = await verifyGroupedRuns(
      [["test/c.test.ts"], ["test/a.test.ts", "test/c.test.ts"]],
      [fastA, timings[2]!],
      options(),
      deps(() => {
        calls += 1;
        return Promise.resolve(passing());
      }),
    );

    expect(failures).toEqual([]);
    expect(calls).toBe(0);
  });
});
