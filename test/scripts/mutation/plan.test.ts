import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  FAST_TEST_MS,
  type PlannedRun,
  planFor,
  quickestFirst,
  runName,
  type TimedTest,
  testPlan,
  timeLimit,
} from "#scripts/mutation/plan.ts";

const timings: readonly TimedTest[] = [
  { file: "test/slowest.test.ts", ms: 60_000 },
  { file: "test/database.test.ts", ms: 4_000 },
  { file: "test/pure-b.test.ts", ms: 300 },
  { file: "test/pure-c.test.ts", ms: 100 },
];

/** The timed files quickest first, ties by name. */
const cheapest = [
  "test/pure-c.test.ts",
  "test/pure-b.test.ts",
  "test/database.test.ts",
  "test/slowest.test.ts",
];

const alone = (files: readonly string[]): string[][] =>
  files.map((file) => [file]);

/** The files of each run in a plan. */
const filesOf = (plan: readonly PlannedRun[]) => plan.map((run) => run.files);

describe("a mutant's test plan", () => {
  test("runs the fast files together, then each slower file alone, cheapest first", () => {
    expect(filesOf(testPlan(timings, 1_000))).toEqual([
      cheapest.slice(0, 2),
      ...alone(cheapest.slice(2)),
    ]);
  });

  test("treats a file at the threshold as slow", () => {
    expect(filesOf(testPlan(timings, 100))).toEqual(alone(cheapest));
  });

  test("runs every file together when all are fast, and plans nothing for no files", () => {
    expect(filesOf(testPlan(timings, 60_001))).toEqual([cheapest]);
    expect(testPlan([], FAST_TEST_MS)).toHaveLength(0);
  });

  test("puts every timed file in exactly one run, whatever the threshold", () => {
    for (const fastMs of [0, 100, 101, 1_000, FAST_TEST_MS, 60_001]) {
      const plan = testPlan(timings, fastMs);
      const files = plan.flatMap((run) => run.files);
      expect(files.toSorted()).toEqual(cheapest.toSorted());
      expect(plan.every((run) => run.files.length > 0)).toBe(true);
    }
  });

  test("adds up a run's baseline times and allows three times that plus 10 s", () => {
    const plan = testPlan(timings, 1_000);
    expect(plan.map((run) => run.ms)).toEqual([400, 4_000, 60_000]);
    expect(plan.map(timeLimit)).toEqual([11_200, 22_000, 190_000]);
  });

  test("orders ties by file name", () => {
    const tied = [
      { file: "test/b.test.ts", ms: 10 },
      { file: "test/a.test.ts", ms: 10 },
    ];
    expect(tied.toSorted(quickestFirst).map((test) => test.file)).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
  });
});

describe("one test set's plan", () => {
  test("uses only the given files, cheapest first", () => {
    expect(
      filesOf(
        planFor(
          [
            "test/pure-b.test.ts",
            "test/slowest.test.ts",
            "test/pure-c.test.ts",
          ],
          timings,
          1_000,
        ),
      ),
    ).toEqual([
      ["test/pure-c.test.ts", "test/pure-b.test.ts"],
      ["test/slowest.test.ts"],
    ]);
  });

  test("refuses a file the baseline never timed", () => {
    expect(() => planFor(["test/unknown.test.ts"], timings)).toThrow(
      "No baseline timing for test/unknown.test.ts.",
    );
  });
});

describe("naming a run", () => {
  test("names the one file, or says how many fast files a run holds", () => {
    expect(runName(["test/a.test.ts"])).toBe("test/a.test.ts");
    expect(runName(["test/a.test.ts", "test/b.test.ts"])).toBe(
      "the 2 fast files",
    );
  });
});
