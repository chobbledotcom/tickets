import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CompactTapSummary,
  type JunitErroredTest,
  junitErroredTests,
  junitErrorFiles,
  printCompactSummary,
} from "#scripts/tap-summary.ts";
import { capturingConsole } from "#test-utils/captured-console.ts";

const summary = (over: Partial<CompactTapSummary> = {}): CompactTapSummary => ({
  droppedLines: [],
  failed: 0,
  failures: [],
  fileEstimate: 0,
  passed: 3,
  sawTap: true,
  skipped: 0,
  suppressedResults: 0,
  ...over,
});

/** Capture what the summary printed to each console stream. */
const printed = (
  result: CompactTapSummary,
  status: number | { code: number; signal?: string | null },
  stderrText: string,
  junitErrorFiles: string[] = [],
  junitErrored: JunitErroredTest[] = [],
): Promise<{ errors: string[]; logs: string[] }> =>
  capturingConsole(() =>
    printCompactSummary(
      result,
      typeof status === "number" ? { code: status, signal: null } : status,
      stderrText,
      junitErrorFiles,
      junitErrored,
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

  test("attributes a cancelled suite to its JUnit declare site", async () => {
    // The hosted shape: every member test passed, then an uncaught error
    // cancelled the suite mid-file. Deno's TAP carries no diagnostic, so
    // the JUnit's errored record is the only attribution there is.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [
          {
            message: "No TAP diagnostic was emitted for this failure.",
            name: "Turso migration file",
          },
        ],
        fileEstimate: 13,
        passed: 12,
      }),
      1,
      "",
      [],
      [
        {
          column: 1,
          file: "./test/scripts/turso-migration-file.test.ts",
          line: 121,
          message: "Cancelled",
          name: "Turso migration file",
        },
      ],
    );

    expect(errors).toEqual([
      "\nFAILED 12 passed, 1 failed",
      "\nFailed tests:",
      "  ./test/scripts/turso-migration-file.test.ts:121:1 - Turso migration file",
      "  deno's runner cancelled this suite after an uncaught error. Its JUnit record says \"Cancelled\"; deno's TAP output carries no rejection text.",
    ]);
  });

  test("leaves an unmatched failure at unknown location", async () => {
    // A JUnit record for another suite must not relocate this failure.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [
          { message: "No TAP diagnostic was emitted.", name: "other suite" },
        ],
        fileEstimate: 2,
        passed: 1,
      }),
      1,
      "",
      [],
      [
        {
          column: 1,
          file: "./elsewhere.test.ts",
          line: 9,
          message: "Cancelled",
          name: "Turso migration file",
        },
      ],
    );

    expect(errors).toEqual([
      "\nFAILED 1 passed, 1 failed",
      "\nFailed tests:",
      "  unknown location - other suite",
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

  test("shows those lines beside counted test failures too", async () => {
    const { errors } = await printed(
      summary({
        droppedLines: ["error: Uncaught TypeError: boom"],
        failed: 1,
        failures: [
          {
            location: {
              column: 3,
              file: "./src/shared/remembered.ts",
              line: 9,
            },
            message: "Values are not strictly equal.",
            name: "keeps an undefined answer",
          },
        ],
      }),
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

  test("reads each errored testcase with its declare site and message", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="deno test" tests="4" failures="0" errors="1">',
      '    <testsuite name="./probe.test.ts" tests="1" disabled="0" errors="1" failures="0">',
      '        <testcase name="probe suite" classname="./probe.test.ts" time="0.000" line="14" col="1">',
      '            <error message="Cancelled"/>',
      "        </testcase>",
      "    </testsuite>",
      '    <testsuite name="./fine.test.ts" tests="1" disabled="0" errors="0" failures="0">',
      '        <testcase name="fine" classname="./fine.test.ts">',
      "        </testcase>",
      "    </testsuite>",
      "</testsuites>",
    ].join("\n");

    expect(junitErroredTests(xml)).toEqual([
      {
        column: 1,
        file: "./probe.test.ts",
        line: 14,
        message: "Cancelled",
        name: "probe suite",
      },
    ]);
  });

  test("answers nothing when no testcase carries an error entry", () => {
    const xml =
      '<testcase name="fine" classname="./fine.test.ts" line="3" col="1"></testcase>';

    expect(junitErroredTests(xml)).toEqual([]);
  });
});
