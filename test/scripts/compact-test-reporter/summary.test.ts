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
  passed: 3,
  sawTap: true,
  ...over,
});

/** Capture what the summary printed to each console stream. */
const printed = (
  result: CompactTapSummary,
  exitCode: number,
  stderrText: string,
): { errors: string[]; logs: string[] } => {
  const logs: string[] = [];
  const errors: string[] = [];
  using _log = stub(console, "log", (line?: unknown) => {
    logs.push(String(line));
  });
  using _error = stub(console, "error", (line?: unknown) => {
    errors.push(String(line));
  });

  printCompactSummary(result, exitCode, stderrText);
  return { errors, logs };
};

describe("printing the run summary", () => {
  test("reports a pass when nothing failed and the run exited cleanly", () => {
    const { errors, logs } = printed(summary(), 0, "");

    expect(logs).toEqual(["\nPASS 3 passed"]);
    expect(errors).toEqual([]);
  });

  test("reports a failure when the run exited non-zero without failed tests", () => {
    const { errors, logs } = printed(summary(), 1, "");

    expect(logs).toEqual([]);
    expect(errors).toEqual(["\nFAILED 3 passed, 0 failed"]);
  });

  test("lists each failed test with where it failed", () => {
    const { errors } = printed(
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

  test("lists a lone failure under the same heading", () => {
    const { errors } = printed(
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

  test("shows the run's own output, minus Deno's own failure line", () => {
    const { errors } = printed(
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

  test("says nothing extra when the run's output was only Deno's failure line", () => {
    const { errors } = printed(summary({ failed: 1 }), 1, "error: Test failed");

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
      const logs: string[] = [];
      using _log = stub(console, "log", (line?: unknown) => {
        logs.push(String(line));
      });
      using _error = stub(console, "error", (line?: unknown) => {
        logs.push(String(line));
      });
      const code = await runCompactDenoTest(
        ["test", "--no-check", "-A", "--reporter=tap", "sample.test.ts"],
        { cwd: dir.path, env: { CI: "1" } },
      );
      return { code, logs };
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
