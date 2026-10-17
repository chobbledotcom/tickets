import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { junitErroredTests, NO_TAP_DIAGNOSTIC } from "#scripts/tap-summary.ts";
import {
  printed,
  printedCancellation,
  summary,
  TURSO_RECORD,
} from "./printed-summary.ts";

describe("JUnit cancellation attribution", () => {
  test("attributes a cancelled suite to its JUnit declare site", async () => {
    // The hosted shape: every member test passed, then an uncaught error
    // cancelled the suite mid-file. Deno's TAP carries no diagnostic, so
    // the JUnit's errored record is the only attribution there is.
    const { errors } = await printedCancellation(
      {
        message: NO_TAP_DIAGNOSTIC,
        name: "Turso migration file",
      },
      [TURSO_RECORD],
    );

    expect(errors).toEqual([
      "\nFAILED 12 passed, 1 failed",
      "\nFailed tests:",
      "  ./test/scripts/turso-migration-file.test.ts:121:1 - Turso migration file",
      "  deno's runner cancelled this suite after an uncaught error. Its JUnit record says \"Cancelled\"; deno's TAP output carries no rejection text.",
    ]);
  });

  test("decodes the JUnit name before matching the failure", async () => {
    // XML escapes '&' in stored names while TAP carries the raw character.
    // The record flows through the real JUnit parse, so the match proves
    // the decode happened before the name comparison.
    const errored = junitErroredTests(
      [
        '<testcase name="probe &amp; suite" classname="./probe.test.ts" line="14" col="1">',
        '            <error message="Cancelled"/>',
        "</testcase>",
      ].join("\n"),
    );

    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [
          {
            message: NO_TAP_DIAGNOSTIC,
            name: "probe & suite",
          },
        ],
        fileEstimate: 3,
        passed: 2,
      }),
      1,
      "",
      [],
      errored,
    );

    expect(errors).toEqual([
      "\nFAILED 2 passed, 1 failed",
      "\nFailed tests:",
      "  ./probe.test.ts:14:1 - probe & suite",
      "  deno's runner cancelled this suite after an uncaught error. Its JUnit record says \"Cancelled\"; deno's TAP output carries no rejection text.",
    ]);
  });

  test("keeps a TAP diagnostic location over a JUnit record", async () => {
    // A failure whose diagnostic names a frame is already pinned down; the
    // JUnit record must not move it.
    const { errors } = await printedCancellation(
      {
        location: { column: 3, file: "./src/shared/real.ts", line: 9 },
        message: "Values are not strictly equal.",
        name: "Turso migration file",
      },
      [TURSO_RECORD],
    );

    expect(errors).toEqual([
      "\nFAILED 12 passed, 1 failed",
      "\nFailed tests:",
      "  ./src/shared/real.ts:9:3 - Turso migration file",
    ]);
  });

  test("does not attribute a repeated suite name", async () => {
    // Two errored records with one name cannot say which declare site
    // applies, so the failure keeps its unknown location.
    const record = {
      column: 1,
      file: "./first.test.ts",
      line: 5,
      message: "Cancelled",
      name: "repeated suite",
    };
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [{ message: NO_TAP_DIAGNOSTIC, name: "repeated suite" }],
        fileEstimate: 2,
        passed: 1,
      }),
      1,
      "",
      [],
      [record, { ...record, file: "./second.test.ts", line: 9 }],
    );

    expect(errors).toEqual([
      "\nFAILED 1 passed, 1 failed",
      "\nFailed tests:",
      "  unknown location - repeated suite",
    ]);
  });

  test("does not attribute a failure a TAP diagnostic described", async () => {
    // A diagnostic with a message but no in-project frame already says what
    // happened; the cancellation line would claim TAP carried no text.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [
          { message: "boom beside the loop", name: "Turso migration file" },
        ],
        fileEstimate: 13,
        passed: 12,
      }),
      1,
      "",
      [],
      [TURSO_RECORD],
    );

    expect(errors).toEqual([
      "\nFAILED 12 passed, 1 failed",
      "\nFailed tests:",
      "  unknown location - Turso migration file",
    ]);
  });

  test("keeps unknown location when the record names no file", async () => {
    // A record without a classname cannot say where the suite was declared.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [
          {
            message: NO_TAP_DIAGNOSTIC,
            name: "Turso migration file",
          },
        ],
        fileEstimate: 13,
        passed: 12,
      }),
      1,
      "",
      [],
      [{ ...TURSO_RECORD, file: "" }],
    );

    expect(errors).toEqual([
      "\nFAILED 12 passed, 1 failed",
      "\nFailed tests:",
      "  unknown location - Turso migration file",
    ]);
  });

  test("matches a TAP-escaped name against its JUnit form", async () => {
    // Deno's TAP output escapes hashes and backslashes in test names; the
    // comparison accepts the escaped form the failure carries.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [
          {
            message: NO_TAP_DIAGNOSTIC,
            name: "probe \\# suite",
          },
        ],
        fileEstimate: 3,
        passed: 2,
      }),
      1,
      "",
      [],
      [
        {
          column: 1,
          file: "./probe.test.ts",
          line: 14,
          message: "Cancelled",
          name: "probe # suite",
        },
      ],
    );

    expect(errors).toEqual([
      "\nFAILED 2 passed, 1 failed",
      "\nFailed tests:",
      "  ./probe.test.ts:14:1 - probe \\# suite",
      "  deno's runner cancelled this suite after an uncaught error. Its JUnit record says \"Cancelled\"; deno's TAP output carries no rejection text.",
    ]);
  });

  test("leaves an unmatched failure at unknown location", async () => {
    // A JUnit record for another suite must not relocate this failure.
    const { errors } = await printed(
      summary({
        failed: 1,
        failures: [{ message: NO_TAP_DIAGNOSTIC, name: "other suite" }],
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
});
