import { expect } from "@std/expect";
import { pathToFileURL } from "node:url";
import {
  CompactTapReporter,
  hasReporterArg,
} from "../../scripts/compact-test-reporter.ts";

const consume = (reporter: CompactTapReporter, lines: string[]): void => {
  for (const line of lines) reporter.consumeLine(line);
};

Deno.test("compact TAP reporter keeps real failures and suppresses parent step summaries", () => {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = Deno.cwd();
  const failureUrl = pathToFileURL(`${cwd}/test/example.test.ts`).href;
  const reporter = new CompactTapReporter({
    cwd,
    estimatedTotal: 4,
    stderr: (line) => err.push(line),
    stdout: (line) => out.push(line),
  });

  consume(reporter, [
    "TAP version 14",
    "# Subtest: outer",
    "    ok 1 - passes",
    "    not ok 2 - fails nested",
    "      ---",
    JSON.stringify({
      at: { file: "test/example.test.ts", line: 171 },
      message:
        `AssertionError: Values differ\n    at Object.<anonymous> (${failureUrl}:12:3)`,
      severity: "fail",
    }),
    "      ...",
    "    not ok 3 - inner",
    "      ---",
    JSON.stringify({
      at: { file: "test/example.test.ts", line: 124 },
      message: "1 test step failed.",
      severity: "fail",
    }),
    "      ...",
    "    1..3",
    "not ok 1 - outer",
    "  ---",
    JSON.stringify({
      at: { file: "test/example.test.ts", line: 4 },
      message: "1 test step failed.",
      severity: "fail",
    }),
    "  ...",
    "1..1",
  ]);

  const summary = reporter.finish();

  expect(summary.passed).toBe(1);
  expect(summary.failed).toBe(1);
  expect(summary.failures[0]?.name).toBe("fails nested");
  expect(summary.failures[0]?.location).toEqual({
    column: 3,
    file: "test/example.test.ts",
    line: 12,
  });
  expect(out).toEqual([
    "ok   [######------------------] 1/4 passes",
  ]);
  expect(err.join("\n")).toContain("AssertionError: Values differ");
  expect(err.join("\n")).not.toContain("1 test step failed.");
});

Deno.test("hasReporterArg detects both Deno reporter flag forms", () => {
  expect(hasReporterArg(["test/"])).toBe(false);
  expect(hasReporterArg(["--reporter", "dot", "test/"])).toBe(true);
  expect(hasReporterArg(["--reporter=tap", "test/"])).toBe(true);
});
