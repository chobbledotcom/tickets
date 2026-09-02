import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  type CoverageFailure,
  findCoverageFailures,
  printCoverageReport,
  printFailureSummary,
} from "#scripts/coverage-check.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { withEnvironment } from "#scripts/test-environment.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Wrap raw lcov lines into one record. */
const recordOf = (lines: string[]): string =>
  `${lines.join("\n")}\nend_of_record\n`;

const linesOf = (source: string, data: string[]): string =>
  recordOf([`SF:${source}`, ...data]);

const failingRecord = (source: string): string =>
  linesOf(source, [
    "FN:1,main",
    "FNDA:5,main",
    "FNF:1",
    "FNH:1",
    "BRDA:3,0,0,1",
    "BRDA:5,0,0,0",
    "BRDA:5,2,0,0",
    "BRDA:6,1,0,-",
    "BRDA:7,0,0,1",
    "BRF:5",
    "BRH:2",
    "DA:1,9",
    "DA:2,0",
    "DA:4,3",
    "DA:12,0",
    "LF:4",
    "LH:2",
  ]);

const cleanRecord = (source: string): string =>
  linesOf(source, ["DA:1,7", "LF:1", "LH:1", "BRDA:1,0,0,1", "BRF:1", "BRH:1"]);

const runWithCapturedErrors = async <Result>(
  run: () => Promise<Result>,
): Promise<{ errors: string[]; result: Result }> => {
  const errors = spy(console, "error");
  try {
    const result = await run();
    return {
      errors: errors.calls.map((call) => String(call.args[0])),
      result,
    };
  } finally {
    errors.restore();
  }
};

describe("findCoverageFailures", () => {
  test("returns null when no record names a source file", () => {
    expect(findCoverageFailures("end_of_record\nDA:1,0\nend_of_record\n")).toBe(
      null,
    );
  });

  test("reports uncovered lines and branches with their line numbers", () => {
    const failures = findCoverageFailures(failingRecord("/tmp/probe.ts"))!;

    expect(failures.length).toBe(1);
    const failure: CoverageFailure = failures[0]!;
    expect(failure.file).toBe("/tmp/probe.ts");
    expect(failure.lines).toEqual({
      covered: 2,
      total: 4,
      uncovered: [2, 12],
    });
    expect(failure.branches).toEqual({
      covered: 2,
      total: 5,
      // Line 5 is named by two zero branches and must appear once.
      uncovered: [5, 6],
    });
  });

  test("keeps a relative SF path as the file name", () => {
    const failures = findCoverageFailures(
      linesOf("src/rel.ts", ["DA:1,0", "LF:1", "LH:0"]),
    )!;

    expect(failures[0]?.file).toBe("src/rel.ts");
    expect(failures[0]?.sourceFile).toBe("src/rel.ts");
  });

  test("drops files that the gate excludes by name", () => {
    const excluded = failingRecord(
      `${projectRoot}/scripts/compact-test-reporter.ts`,
    );

    expect(findCoverageFailures(excluded + cleanRecord("src/ok.ts"))).toEqual(
      [],
    );
  });

  test("reports a lines-only failure when branch totals are healthy", () => {
    const failures = findCoverageFailures(
      linesOf("/tmp/lines-only.ts", [
        "DA:1,4",
        "DA:2,0",
        "LF:2",
        "LH:1",
        "BRF:1",
        "BRH:1",
      ]),
    )!;

    expect(failures[0]?.lines?.uncovered).toEqual([2]);
    expect(failures[0]?.branches).toBeUndefined();
  });

  test("counts fewer hits than found lines as gaps with no line numbers", () => {
    const failures = findCoverageFailures(
      linesOf("/tmp/unknown-lines.ts", [
        "DA:1,9",
        "DA:4,8",
        "LF:3",
        "LH:2",
        "BRF:1",
        "BRH:1",
      ]),
    )!;

    expect(failures[0]?.lines).toEqual({ covered: 2, total: 3, uncovered: [] });
  });

  test("reports a branches-only failure when line totals are missing", () => {
    const failures = findCoverageFailures(
      linesOf("/tmp/branches-only.ts", ["BRDA:5,0,0,0", "BRF:2", "BRH:1"]),
    )!;

    expect(failures[0]?.branches).toEqual({
      covered: 1,
      total: 2,
      uncovered: [5],
    });
    expect(failures[0]?.lines).toBeUndefined();
  });

  test("reports nothing for records whose metrics are complete", () => {
    const failures = findCoverageFailures(
      cleanRecord("src/clean.ts") + failingRecord("/x.ts"),
    )!;

    expect(failures.length).toBe(1);
    expect(failures[0]?.file).toBe("/x.ts");
  });
});

describe("printFailureSummary", () => {
  test("prints source lines around each uncovered line", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "sourced.txt");
      await Deno.writeTextFile(
        source,
        Array.from({ length: 12 }, (_, i) => `row number ${i + 1}`).join("\n"),
      );

      const failure: CoverageFailure = {
        branches: { covered: 1, total: 2, uncovered: [10] },
        file: "sourced.txt",
        lines: { covered: 9, total: 12, uncovered: [2, 10] },
        sourceFile: source,
      };
      const { errors } = await runWithCapturedErrors(() =>
        printFailureSummary(failure),
      );
      const text = errors.join("\n");
      expect(text).toContain("missing 2, 10");
      expect(text).toContain("missing 10");
      expect(text).toContain("| row number 2");
      expect(text).toContain("| row number 10");
      // The jump from the lines around 2 to the lines around 10 is shown.
      expect(text).toContain("    ...");
    });
  });

  test("prints no snippet block when the source file is missing", async () => {
    const failure: CoverageFailure = {
      branches: { covered: 0, total: 1, uncovered: [1] },
      file: "gone.ts",
      sourceFile: "/nonexistent/gone.ts",
    };
    const { errors } = await runWithCapturedErrors(() =>
      printFailureSummary(failure),
    );
    const text = errors.join("\n");
    expect(text).toContain("missing 1");
    expect(text).not.toContain("snippets");
  });

  test("prints snippets for a failure that only has branches", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "branchy.txt");
      await Deno.writeTextFile(source, "alpha\nbeta\ngamma\n");

      const failure: CoverageFailure = {
        branches: { covered: 0, total: 1, uncovered: [2] },
        file: "branchy.txt",
        sourceFile: source,
      };
      const { errors } = await runWithCapturedErrors(() =>
        printFailureSummary(failure),
      );
      expect(errors.join("\n")).toContain("| beta");
    });
  });

  test("prints the unknown range when no line is dead", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "unknown.txt");
      await Deno.writeTextFile(source, "only one line here\n");

      const failure: CoverageFailure = {
        file: "unknown.txt",
        lines: { covered: 2, total: 3, uncovered: [] },
        sourceFile: source,
      };
      const { errors } = await runWithCapturedErrors(() =>
        printFailureSummary(failure),
      );
      expect(errors.join("\n")).toContain("missing unknown");
    });
  });

  test("caps the visible snippet lines and counts the rest", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "long.txt");
      await Deno.writeTextFile(
        source,
        `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
      );

      const failure: CoverageFailure = {
        file: "long.txt",
        // Uncovered lines beyond the first line and past the file end.
        lines: {
          covered: 10,
          total: 40,
          uncovered: [2, ...Array.from({ length: 27 }, (_, i) => i + 3), 55],
        },
        sourceFile: source,
      };
      const { errors } = await runWithCapturedErrors(() =>
        printFailureSummary(failure),
      );
      const text = errors.join("\n");
      expect(text).toContain("| line 1");
      expect(text).toContain("more source lines");
    });
  });
});

describe("printCoverageReport", () => {
  const withLinesFailing = (): CoverageFailure[] =>
    findCoverageFailures(
      linesOf("/tmp/x.ts", ["DA:1,0", "LF:1", "LH:0", "BRF:0", "BRH:0"]),
    )!;

  test("returns 0 and names the clean state for no failures", async () => {
    const logged = spy(console, "log");
    try {
      expect(await printCoverageReport([])).toBe(0);
    } finally {
      logged.restore();
    }
    expect(logged.calls[0]?.args[0]).toContain(
      "All files have 100% line and branch coverage",
    );
  });

  test("returns 1 for missing coverage data", async () => {
    expect(await printCoverageReport(null)).toBe(1);
  });

  test("returns 1 for failures and prints the rules", async () => {
    const { errors, result } = await runWithCapturedErrors(() =>
      printCoverageReport(withLinesFailing()),
    );

    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("Test quality rules");
  });

  test("prints no GitHub annotations outside a CI run", async () => {
    const { errors } = await withEnvironment(
      { GITHUB_ACTIONS: undefined },
      () =>
        runWithCapturedErrors(() => printCoverageReport(withLinesFailing())),
    );

    expect(errors.join("\n")).not.toContain("::error");
  });

  test("prints GitHub annotations in a CI run and caps them", async () => {
    const entries = Array.from(
      { length: 101 },
      (_, i) => `BRDA:${i + 1},0,0,0`,
    );
    const failure = findCoverageFailures(
      linesOf("/tmp/many.ts", [
        "DA:1,0",
        "LF:1",
        "LH:0",
        ...entries,
        "BRF:101",
        "BRH:0",
      ]) + linesOf("/tmp/branch-only.ts", ["BRDA:2,0,0,0", "BRF:1", "BRH:0"]),
    );

    const { errors } = await withEnvironment({ GITHUB_ACTIONS: "1" }, () =>
      runWithCapturedErrors(() => printCoverageReport(failure!)),
    );

    const text = errors.join("\n");
    expect(text).toContain("::error file=");
    expect(text).toContain("additional coverage annotations omitted");
  });
});
