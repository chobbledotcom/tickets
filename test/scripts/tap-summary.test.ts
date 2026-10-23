import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { printed, summary } from "./tap-summary/printed-summary.ts";

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

    assertArrayIncludes(errors, ["deno exited with code 1"]);
  });

  test("states the signal that killed the child", async () => {
    const { errors } = await printed(
      summary(),
      { code: 137, signal: "SIGKILL" },
      "",
    );

    assertArrayIncludes(errors, [
      "deno exited with code 137, killed by SIGKILL",
    ]);
  });

  test("names the files deno's JUnit report holds uncaught errors for", async () => {
    const { errors } = await printed(
      summary({ lastResultName: "db > migration chain (shard 3/4)" }),
      1,
      "",
      ["./.test-groups/group-23.test.ts", "./.test-groups/group-40.test.ts"],
    );

    assertArrayIncludes(errors, [
      "\ndeno's JUnit report marks these files with uncaught errors:",
    ]);
    assertArrayIncludes(errors, ["  ./.test-groups/group-23.test.ts"]);
    assertArrayIncludes(errors, ["  ./.test-groups/group-40.test.ts"]);
  });

  test("shows the stdout lines the TAP stream carried beside the results", async () => {
    const { errors } = await printed(
      summary({ droppedLines: ["error: Uncaught TypeError: boom"] }),
      1,
      "",
    );

    assertArrayIncludes(errors, [
      "\nStdout lines deno printed beside the TAP results:",
    ]);
    assertArrayIncludes(errors, ["error: Uncaught TypeError: boom"]);
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

    assertArrayIncludes(errors, [
      "\nStdout lines deno printed beside the TAP results:",
    ]);
    assertArrayIncludes(errors, ["error: Uncaught TypeError: boom"]);
  });
});
