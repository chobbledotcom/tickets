import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type CompactTapSummary,
  junitErrorFiles,
  printCompactSummary,
  runCompactDenoTest,
} from "#scripts/compact-test-reporter.ts";
import { runTests } from "#scripts/test-harness.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

const summary = (over: Partial<CompactTapSummary> = {}): CompactTapSummary => ({
  droppedLines: [],
  failed: 0,
  failures: [],
  fileEstimate: 0,
  passed: 3,
  sawTap: true,
  suppressedResults: 0,
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
  status: number | { code: number; signal?: string | null },
  stderrText: string,
  junitErrorFiles: string[] = [],
): Promise<{ errors: string[]; logs: string[] }> =>
  capturingConsole(() =>
    printCompactSummary(
      result,
      typeof status === "number" ? { code: status, signal: null } : status,
      stderrText,
      junitErrorFiles,
    ),
  );

describe("printing the run summary", () => {
  test("reports a pass when nothing failed and the run exited cleanly", async () => {
    const { errors, logs } = await printed(summary(), 0, "");

    expect(logs).toEqual(["\nPASS 3 passed"]);
    expect(errors).toEqual([]);
  });

  test("states the exit facts when the run exited non-zero without failed tests", async () => {
    const { errors, logs } = await printed(
      summary({
        fileEstimate: 29548,
        lastResultName: "the last result",
        passed: 27532,
      }),
      { code: 137, signal: "SIGKILL" },
      "",
    );

    expect(logs).toEqual([]);
    expect(errors).toEqual([
      "\nFAILED 27532 passed, 0 failed",
      "deno exited with code 137, killed by SIGKILL",
      "\ndeno printed no cause for this exit on either stream.",
      "The last result shown was: the last result",
      "The declaration estimate is 2016 above the results the output reported.",
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
      "deno exited with code 1",
      "\ndeno printed no cause for this exit on either stream.",
      "The last result shown was: the last result",
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
      "deno exited with code 1",
      "\ndeno printed no cause for this exit on either stream.",
      "The last result shown was: (none)",
      "The declaration estimate is 3 above the results the output reported.",
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
      "The declaration estimate is 3 above the results the output reported.",
      "\nFailed tests:",
      "  unknown location - only",
    ]);
  });

  test("keeps suppressed parent summaries out of the shortfall", async () => {
    // A complete BDD run whose child step failed: every TAP result arrived,
    // and the parent summaries the reporter drops must not read as lost.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [{ message: "boom", name: "child" }],
        fileEstimate: 3,
        passed: 1,
        suppressedResults: 2,
      }),
      1,
      "",
    );

    expect(errors).toEqual([
      "\nFAILED 1 passed, 1 failed",
      "\nFailed tests:",
      "  unknown location - child",
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
      "deno exited with code 1",
      "The last result shown was: (none)",
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
      "deno exited with code 1",
      "\ndeno printed no cause for this exit on either stream.",
      "The last result shown was: (none)",
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

  test("states the exit code when no test failed and the run errored", async () => {
    const { errors } = await printed(summary(), 1, "");

    expect(errors).toContain("deno exited with code 1");
  });

  test("states the signal that killed the child", async () => {
    const { errors } = await printed(
      summary(),
      { code: 137, signal: "SIGKILL" },
      "",
    );

    expect(errors).toContain("deno exited with code 137, killed by SIGKILL");
  });

  test("names the files deno's JUnit report holds uncaught errors for", async () => {
    const { errors } = await printed(
      summary({ lastResultName: "db > migration chain (shard 3/4)" }),
      1,
      "",
      ["./.test-groups/group-23.test.ts", "./.test-groups/group-40.test.ts"],
    );

    expect(errors).toContain(
      "\ndeno's JUnit report marks these files with uncaught errors:",
    );
    expect(errors).toContain("  ./.test-groups/group-23.test.ts");
    expect(errors).toContain("  ./.test-groups/group-40.test.ts");
  });

  test("shows the stdout lines the TAP stream carried beside the results", async () => {
    const { errors } = await printed(
      summary({ droppedLines: ["error: Uncaught TypeError: boom"] }),
      1,
      "",
    );

    expect(errors).toContain(
      "\nStdout lines deno printed beside the TAP results:",
    );
    expect(errors).toContain("error: Uncaught TypeError: boom");
  });
});

describe("reading deno's JUnit report for uncaught errors", () => {
  test("names the suites whose tests carry error entries", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="deno test" tests="3" failures="0" errors="2">',
      '    <testsuite name="./fine.test.ts" tests="1" errors="0" failures="0">',
      '        <testcase name="fine" classname="./fine.test.ts">',
      "        </testcase>",
      "    </testsuite>",
      '    <testsuite name="./uncaught.test.ts" tests="2" errors="2" failures="0">',
      '        <testcase name="starts" classname="./uncaught.test.ts">',
      '            <error message="Cancelled"/>',
      "        </testcase>",
      "    </testsuite>",
      "</testsuites>",
    ].join("\n");

    expect(junitErrorFiles(xml)).toEqual(["./uncaught.test.ts"]);
  });

  test("answers nothing when the report holds no error entries", () => {
    const xml =
      '<testsuite name="./fine.test.ts" tests="1" errors="0" failures="0"></testsuite>';

    expect(junitErrorFiles(xml)).toEqual([]);
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

  test("shows an error line a dying child printed on stdout", async () => {
    const dir: TempPath = tempDir();
    try {
      const { errors, value } = await capturingConsole(() =>
        runCompactDenoTest(
          [
            "eval",
            'console.log("error: Uncaught boom from the dying child"); Deno.exit(1);',
          ],
          { cwd: dir.path, env: { CI: "1" } },
        )
      );

      expect(value).toBe(1);
      expect(errors.join("\n")).toContain(
        "error: Uncaught boom from the dying child",
      );
      expect(errors.join("\n")).toContain("deno exited with code 1");
    } finally {
      dir.dispose();
    }
  });

  test("lets a JUnit read failure other than a missing file surface", async () => {
    const dir: TempPath = tempDir();
    try {
      await expect(
        runCompactDenoTest(["eval", "Deno.exit(0);"], {
          cwd: dir.path,
          env: { CI: "1" },
          junitPath: dir.path,
        }),
      ).rejects.toThrow();
    } finally {
      dir.dispose();
    }
  });

  test("names the uncaught-error file a focused run's JUnit report holds", async () => {
    const dir: TempPath = tempDir();
    try {
      Deno.writeTextFileSync(
        `${dir.path}/crashes.test.ts`,
        [
          "Deno.test(\"starts\", () => {",
          "  queueMicrotask(() => { throw new Error(\"boom-mid-run\"); });",
          "});",
        ].join("\n"),
      );
      const { errors, value } = await capturingConsole(() =>
        runTests([`${dir.path}/crashes.test.ts`], false)
      );

      expect(value).not.toBe(0);
      expect(errors.join("\n")).toContain(
        "\ndeno's JUnit report marks these files with uncaught errors:",
      );
      expect(errors.join("\n")).toContain("crashes.test.ts");
    } finally {
      dir.dispose();
    }
  });
});
