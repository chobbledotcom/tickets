import { pathToFileURL } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CompactFailure,
  CompactTapReporter,
} from "#scripts/compact-test-reporter.ts";

const cwd = Deno.cwd();

/** Feed TAP lines to a reporter and hand back what it recorded and printed. */
const report = (
  lines: string[],
): { err: string[]; failures: CompactFailure[]; out: string[] } => {
  const err: string[] = [];
  const out: string[] = [];
  const reporter = new CompactTapReporter({
    cwd,
    hideProgress: true,
    stderr: (line) => err.push(line),
    stdout: (line) => out.push(line),
  });
  for (const line of lines) reporter.consumeLine(line);
  return { err, failures: reporter.finish().failures, out };
};

/** The one failure the given TAP lines produced. */
const onlyFailure = (lines: string[]): CompactFailure => {
  const { failures } = report(lines);
  expect(failures.length).toBe(1);
  // The length check above guarantees this is present.
  return failures[0] as CompactFailure;
};

describe("reading a failure's diagnostic block", () => {
  test("says so when the block is empty", () => {
    const failure = onlyFailure([
      "not ok 1 - empty block",
      "  ---",
      "   ",
      "  ...",
    ]);

    expect(failure.message).toBe(
      "No TAP diagnostic was emitted for this failure.",
    );
    expect(failure.location).toBeUndefined();
  });

  test("says so when the failure has no block at all", () => {
    const failure = onlyFailure(["not ok 1 - no block", "ok 2 - next"]);

    expect(failure.message).toBe(
      "No TAP diagnostic was emitted for this failure.",
    );
  });

  test("records a failure left pending when the stream ends", () => {
    const failure = onlyFailure(["not ok 1 - last line of the run"]);

    expect(failure.name).toBe("last line of the run");
  });

  test("keeps a block that is neither JSON nor YAML as the message", () => {
    const failure = onlyFailure([
      "not ok 1 - plain text",
      "  ---",
      "  something went wrong",
      "  ...",
    ]);

    expect(failure.message).toBe("something went wrong");
  });

  test("unquotes a quoted YAML message", () => {
    const failure = onlyFailure([
      "not ok 1 - quoted",
      "  ---",
      '  message: "line one\\nline two"',
      "  ...",
    ]);

    expect(failure.message).toBe("line one\nline two");
  });

  test("strips the quotes when a quoted message is not valid JSON", () => {
    const failure = onlyFailure([
      "not ok 1 - single quoted",
      "  ---",
      "  message: 'it went \\wrong'",
      "  ...",
    ]);

    expect(failure.message).toBe("it went \\wrong");
  });

  test("keeps a block message's own indentation", () => {
    const failure = onlyFailure([
      "not ok 1 - block",
      "  ---",
      "  message: |-",
      "    first",
      "      indented",
      "  severity: fail",
      "  ...",
    ]);

    expect(failure.message).toBe("first\n  indented");
  });

  test("falls back when a diagnostic carries no message at all", () => {
    const failure = onlyFailure([
      "not ok 1 - no message",
      "  ---",
      '  {"severity": "fail"}',
      "  ...",
    ]);

    expect(failure.message).toBe("No failure message was emitted.");
  });

  test("reads the file, line, and column from an at: block", () => {
    const failure = onlyFailure([
      "not ok 1 - located",
      "  ---",
      "  message: it broke",
      "  at:",
      "    file: test/example.test.ts",
      "    line: 12",
      "    column: 5",
      "  severity: fail",
      "  ...",
    ]);

    expect(failure.location).toEqual({
      column: 5,
      file: "test/example.test.ts",
      line: 12,
    });
  });

  test("ignores an at: block that names no file", () => {
    const failure = onlyFailure([
      "not ok 1 - no file",
      "  ---",
      "  message: it broke",
      "  at:",
      "    line: 12",
      "  ...",
    ]);

    expect(failure.location).toBeUndefined();
  });
});

describe("finding where a failure happened", () => {
  test("prefers the first in-project frame of the stack", () => {
    const outside = pathToFileURL("/elsewhere/lib.ts").href;
    const inside = pathToFileURL(`${cwd}/test/example.test.ts`).href;
    const failure = onlyFailure([
      "not ok 1 - stack",
      "  ---",
      `  message: "boom\\n    at (${outside}:9:1)\\n    at (${inside}:34:7)"`,
      "  ...",
    ]);

    expect(failure.location).toEqual({
      column: 7,
      file: "test/example.test.ts",
      line: 34,
    });
  });

  test("falls back to the at: block when no frame is in the project", () => {
    const outside = pathToFileURL("/elsewhere/lib.ts").href;
    const failure = onlyFailure([
      "not ok 1 - outside",
      "  ---",
      `  message: "boom at (${outside}:9:1)"`,
      "  at:",
      "    file: test/example.test.ts",
      "    line: 4",
      "  ...",
    ]);

    expect(failure.location).toEqual({
      column: undefined,
      file: "test/example.test.ts",
      line: 4,
    });
  });

  test("prints the file, line, and column beneath the failure", () => {
    const inside = pathToFileURL(`${cwd}/test/example.test.ts`).href;
    const { err } = report([
      "not ok 1 - printed",
      "  ---",
      `  message: "boom\\n    at (${inside}:34:7)"`,
      "  ...",
    ]);

    expect(err[0]).toBe("fail printed");
    expect(err[1]).toBe("     at test/example.test.ts:34:7");
    expect(err[2]).toBe("     boom");
  });

  test("prints 'unknown location' when nothing pins the failure down", () => {
    const { err } = report([
      "not ok 1 - unpinned",
      "  ---",
      "  message: boom",
      "  ...",
    ]);

    expect(err[1]).toBe("     at unknown location");
  });
});

describe("reading TAP result lines", () => {
  test("names a result line that carries no test name", () => {
    expect(onlyFailure(["not ok 1"]).name).toBe("(unnamed test)");
  });

  test("drops a SKIP or TODO directive from the name", () => {
    const { out } = report(["ok 1 - slow case # SKIP too slow"]);

    expect(out).toEqual(["ok   slow case"]);
  });

  test("ignores lines that are not TAP results", () => {
    const { out, failures } = report([
      "# Subtest: outer",
      "Download https://example.com/module.ts",
      "",
      "ok 1 - counted",
    ]);

    expect(out).toEqual(["ok   counted"]);
    expect(failures).toEqual([]);
  });

  test("ignores a stray diagnostic block with no failure to attach it to", () => {
    const { failures, out } = report([
      "ok 1 - passes",
      "  ---",
      "  message: stray",
      "  ...",
      "ok 2 - also passes",
    ]);

    expect(failures).toEqual([]);
    expect(out).toEqual(["ok   passes", "ok   also passes"]);
  });
});
