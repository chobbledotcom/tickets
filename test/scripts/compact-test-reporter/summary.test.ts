import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type CompactTapSummary,
  printCompactSummary,
  runCompactDenoTest,
} from "#scripts/compact-test-reporter.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

const summary = (over: Partial<CompactTapSummary> = {}): CompactTapSummary => ({
  failed: 0,
  failures: [],
  fileEstimate: 0,
  passed: 3,
  sawTap: true,
  ...over,
});

/** Run something with the console captured, keeping each stream apart. */
const capturingConsole = async <T>(
  run: () => T | Promise<T>,
): Promise<{ errors: string[]; logs: string[]; value: T }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  using _log = stub(console, "log", (line?: unknown) => {
    logs.push(String(line));
  });
  using _error = stub(console, "error", (line?: unknown) => {
    errors.push(String(line));
  });

  return { errors, logs, value: await run() };
};

/** Capture what the summary printed to each console stream. */
const printed = (
  result: CompactTapSummary,
  exitCode: number,
  stderrText: string,
): Promise<{ errors: string[]; logs: string[] }> =>
  capturingConsole(() => printCompactSummary(result, exitCode, stderrText));

describe("printing the run summary", () => {
  test("reports a pass when nothing failed and the run exited cleanly", async () => {
    const { errors, logs } = await printed(summary(), 0, "");

    expect(logs).toEqual(["\nPASS 3 passed"]);
    expect(errors).toEqual([]);
  });

  test("says a worker died when the run exited non-zero without failed tests", async () => {
    const { errors, logs } = await printed(
      summary({
        fileEstimate: 29548,
        lastResultName: "the last result",
        passed: 27532,
      }),
      137,
      "",
    );

    expect(logs).toEqual([]);
    expect(errors).toEqual([
      "\nFAILED 27532 passed, 0 failed",
      "\nA test worker probably died, and the tests it still held did not report.",
      "2016 of the 29548 expected tests did not report.",
      "The last result shown was: the last result",
      "If this repeats, rerun with fewer workers, for example DENO_JOBS=4.",
    ]);
  });

  test("names no shortfall when every expected test reported", async () => {
    const { errors } = await printed(
      summary({ fileEstimate: 3, lastResultName: "the last result" }),
      1,
      "",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 0 failed",
      "\nThe run exited with an error, but no test failed.",
      "A test worker can die before its tests report.",
      "The last result shown was: the last result",
      "If this repeats, rerun with fewer workers, for example DENO_JOBS=4.",
    ]);
  });

  test("says no result was shown when the worker died before one", async () => {
    const { errors } = await printed(
      summary({ fileEstimate: 3, passed: 0 }),
      1,
      "",
    );

    expect(errors).toEqual([
      "\nFAILED 0 passed, 0 failed",
      "\nA test worker probably died, and the tests it still held did not report.",
      "3 of the 3 expected tests did not report.",
      "The last result shown was: (none)",
      "If this repeats, rerun with fewer workers, for example DENO_JOBS=4.",
    ]);
  });

  test("reports the shortfall beside the counted failures", async () => {
    const { errors } = await printed(
      summary({
        failed: 2,
        failures: [{ message: "boom", name: "only" }],
        fileEstimate: 8,
        passed: 3,
      }),
      1,
      "",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 2 failed",
      "\n3 of the 8 expected tests did not report.",
      "\nFailed tests:",
      "  unknown location - only",
    ]);
  });

  test("blames the reported error instead of a worker when stderr names one", async () => {
    const { errors } = await printed(
      summary(),
      1,
      "error: Test failed\nTypeError: Cannot read properties of undefined\n",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 0 failed",
      "\nDeno output:",
      "TypeError: Cannot read properties of undefined",
    ]);
  });

  test("filters Deno's own failure line even when it carries colour codes", async () => {
    const { errors } = await printed(
      summary(),
      1,
      "\u001b[0m\u001b[1m\u001b[31merror\u001b[0m: Test failed\n",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 0 failed",
      "\nThe run exited with an error, but no test failed.",
      "A test worker can die before its tests report.",
      "The last result shown was: (none)",
      "If this repeats, rerun with fewer workers, for example DENO_JOBS=4.",
    ]);
  });

  test("lists each failed test with where it failed", async () => {
    const { errors } = await printed(
      summary({
        failed: 2,
        failures: [
          {
            location: { column: 3, file: "test/a.test.ts", line: 7 },
            message: "boom",
            name: "first",
          },
          { message: "bang", name: "second" },
        ],
      }),
      1,
      "",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 2 failed",
      "\nFailed tests:",
      "  test/a.test.ts:7:3 - first",
      "  unknown location - second",
    ]);
  });

  test("lists a lone failure under the same heading", async () => {
    const { errors } = await printed(
      summary({ failed: 1, failures: [{ message: "boom", name: "only" }] }),
      1,
      "",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 1 failed",
      "\nFailed tests:",
      "  unknown location - only",
    ]);
  });

  test("shows the run's own output, minus Deno's own failure line", async () => {
    const { errors } = await printed(
      summary({ failed: 1 }),
      1,
      "error: Test failed\nTypeError: x is not a function\n    at load\n",
    );

    expect(errors).toEqual([
      "\nFAILED 3 passed, 1 failed",
      "\nDeno output:",
      "TypeError: x is not a function\n    at load",
    ]);
  });

  test("says nothing extra when the run's output was only Deno's failure line", async () => {
    const { errors } = await printed(
      summary({ failed: 1 }),
      1,
      "error: Test failed",
    );

    expect(errors).toEqual(["\nFAILED 3 passed, 1 failed"]);
  });
});

describe("running deno test with the compact reporter", () => {
  /** Write a one-test file and run the compact reporter over it. */
  const runOver = async (
    body: string,
  ): Promise<{ code: number; logs: string[] }> => {
    const dir: TempPath = tempDir();
    try {
      Deno.writeTextFileSync(`${dir.path}/sample.test.ts`, body);
      const { errors, logs, value } = await capturingConsole(() =>
        runCompactDenoTest(
          ["test", "--no-check", "-A", "--reporter=tap", "sample.test.ts"],
          { cwd: dir.path, env: { CI: "1" } },
        ),
      );
      return { code: value, logs: [...logs, ...errors] };
    } finally {
      dir.dispose();
    }
  };

  test("reports a passing file and exits with its code", async () => {
    const { code, logs } = await runOver('Deno.test("works", () => {});');

    expect(code).toBe(0);
    expect(logs).toContain("Running tests...");
    expect(logs).toContain("\nPASS 1 passed");
    // CI in the environment hides the progress bar.
    expect(logs).toContain("ok   works");
  });

  test("reports a failing file and exits with its code", async () => {
    const { code, logs } = await runOver(
      'Deno.test("breaks", () => { throw new Error("nope"); });',
    );

    expect(code).not.toBe(0);
    expect(logs).toContain("\nFAILED 0 passed, 1 failed");
    expect(logs.join("\n")).toContain("nope");
  });
});
