import { pathToFileURL } from "node:url";
import { expect } from "@std/expect";
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
      message: `AssertionError: Values differ\n    at Object.<anonymous> (${failureUrl}:12:3)`,
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
  expect(out).toEqual(["ok   [######------------------] 1/4 passes"]);
  expect(err.join("\n")).toContain("AssertionError: Values differ");
  expect(err.join("\n")).not.toContain("1 test step failed.");
});

Deno.test("compact TAP reporter buffers pretty JSON diagnostic blocks", () => {
  const err: string[] = [];
  const cwd = Deno.cwd();
  const failureUrl = pathToFileURL(`${cwd}/test/json.test.ts`).href;
  const reporter = new CompactTapReporter({
    cwd,
    stderr: (line) => err.push(line),
    stdout: () => {},
  });

  consume(reporter, [
    "TAP version 14",
    "not ok 1 - fails with pretty JSON",
    "  ---",
    ...JSON.stringify(
      {
        at: { file: "test/json.test.ts", line: 99 },
        message: `AssertionError: JSON details survived\n    at Object.<anonymous> (${failureUrl}:34:5)`,
        severity: "fail",
      },
      null,
      2,
    )
      .split("\n")
      .map((line) => `  ${line}`),
    "  ...",
    "1..1",
  ]);

  const summary = reporter.finish();

  expect(summary.failed).toBe(1);
  expect(summary.failures[0]?.message).toContain("JSON details survived");
  expect(summary.failures[0]?.location).toEqual({
    column: 5,
    file: "test/json.test.ts",
    line: 34,
  });
  expect(err.join("\n")).not.toContain("No TAP diagnostic was emitted");
});

Deno.test("compact TAP reporter parses YAML diagnostic blocks and suppresses parent summaries", () => {
  const err: string[] = [];
  const cwd = Deno.cwd();
  const failureUrl = pathToFileURL(`${cwd}/test/yaml.test.ts`).href;
  const reporter = new CompactTapReporter({
    cwd,
    stderr: (line) => err.push(line),
    stdout: () => {},
  });

  consume(reporter, [
    "TAP version 14",
    "not ok 1 - fails with YAML",
    "  ---",
    "  message: |-",
    "    AssertionError: YAML details survived",
    `      at Object.<anonymous> (${failureUrl}:56:7)`,
    "  severity: fail",
    "  at:",
    "    file: test/yaml.test.ts",
    "    line: 12",
    "  ...",
    "not ok 2 - parent suite",
    "  ---",
    "  message: 1 test step failed.",
    "  severity: fail",
    "  at:",
    "    file: test/yaml.test.ts",
    "    line: 4",
    "  ...",
    "1..2",
  ]);

  const summary = reporter.finish();

  expect(summary.failed).toBe(1);
  expect(summary.failures[0]?.name).toBe("fails with YAML");
  expect(summary.failures[0]?.message).toContain("YAML details survived");
  expect(summary.failures[0]?.location).toEqual({
    column: 7,
    file: "test/yaml.test.ts",
    line: 56,
  });
  expect(err.join("\n")).not.toContain("No TAP diagnostic was emitted");
  expect(err.join("\n")).not.toContain("1 test step failed.");
});

Deno.test("compact TAP reporter can hide progress for CI output", () => {
  const out: string[] = [];
  const reporter = new CompactTapReporter({
    cwd: Deno.cwd(),
    estimatedTotal: 2,
    hideProgress: true,
    stdout: (line) => out.push(line),
  });

  consume(reporter, [
    "TAP version 14",
    "ok 1 - passes without progress",
    "1..1",
  ]);

  expect(reporter.finish().passed).toBe(1);
  expect(out).toEqual(["ok   passes without progress"]);
});

Deno.test("compact TAP reporter grows the estimated total when it is exceeded", () => {
  const out: string[] = [];
  const reporter = new CompactTapReporter({
    cwd: Deno.cwd(),
    estimatedTotal: 1,
    stdout: (line) => out.push(line),
  });

  consume(reporter, [
    "TAP version 14",
    "ok 1 - first",
    "ok 2 - second",
    "1..2",
  ]);

  expect(reporter.finish().passed).toBe(2);
  expect(out).toEqual([
    "ok   [########################] 1/1 first",
    "ok   [########################] 2/2 second",
  ]);
});

Deno.test("hasReporterArg detects both Deno reporter flag forms", () => {
  expect(hasReporterArg(["test/"])).toBe(false);
  expect(hasReporterArg(["--reporter", "dot", "test/"])).toBe(true);
  expect(hasReporterArg(["--reporter=tap", "test/"])).toBe(true);
});
