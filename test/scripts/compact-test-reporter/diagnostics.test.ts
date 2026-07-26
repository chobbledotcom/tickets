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
    const { failures, out } = report(["not ok 1 - no block", "ok 2 - next"]);

    expect(failures[0]?.message).toBe(
      "No TAP diagnostic was emitted for this failure.",
    );
    expect(out).toEqual(["ok   next"]);
  });

  test("reads a block the run ended without closing", () => {
    const failure = onlyFailure([
      "not ok 1 - cut short",
      "  ---",
      "  message: the run stopped here",
    ]);

    expect(failure.message).toBe("the run stopped here");
  });

  test("keeps a message with a quote only at its end", () => {
    const failure = onlyFailure([
      "not ok 1 - trailing quote",
      "  ---",
      '  message: it said "hi"',
      "  ...",
    ]);

    expect(failure.message).toBe('it said "hi"');
  });

  test("keeps a message with a quote only at its start", () => {
    const failure = onlyFailure([
      "not ok 1 - leading quote",
      "  ---",
      "  message: 'tis broken",
      "  ...",
    ]);

    expect(failure.message).toBe("'tis broken");
  });

  test("keeps a message that opens with a quote but never closes it", () => {
    const failure = onlyFailure([
      "not ok 1 - unclosed quote",
      "  ---",
      '  message: "hi there',
      "  ...",
    ]);

    expect(failure.message).toBe('"hi there');
  });

  test("keeps a message that closes with a quote it never opened", () => {
    const failure = onlyFailure([
      "not ok 1 - stray closing quote",
      "  ---",
      "  message: hello'",
      "  ...",
    ]);

    expect(failure.message).toBe("hello'");
  });

  test("keeps the block text when the message line is empty", () => {
    const failure = onlyFailure([
      "not ok 1 - empty message",
      "  ---",
      "  message:",
      "  ...",
    ]);

    expect(failure.message).toBe("message:");
  });

  test("measures the block's indent from its shortest indented line", () => {
    const failure = onlyFailure([
      "not ok 1 - one-letter line",
      "  ---",
      "  message: |-",
      "      first",
      "    x",
      "  ...",
    ]);

    expect(failure.message).toBe("  first\nx");
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

  test("prints just the file when the diagnostic gives no line", () => {
    const { err } = report([
      "not ok 1 - file only",
      "  ---",
      "  message: boom",
      "  at:",
      "    file: test/example.test.ts",
      "  ...",
    ]);

    expect(err[1]).toBe("     at test/example.test.ts");
  });

  test("prints the file and line when the diagnostic gives no column", () => {
    const { err } = report([
      "not ok 1 - no column",
      "  ---",
      "  message: boom",
      "  at:",
      "    file: test/example.test.ts",
      "    line: 9",
      "  ...",
    ]);

    expect(err[1]).toBe("     at test/example.test.ts:9");
  });

  test("names the project root itself when a frame points at it", () => {
    const root = pathToFileURL(cwd).href;
    const failure = onlyFailure([
      "not ok 1 - at the root",
      "  ---",
      `  message: "boom at (${root}:3:1)"`,
      "  ...",
    ]);

    expect(failure.location).toEqual({ column: 1, file: ".", line: 3 });
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

  test("keeps an empty name empty rather than calling it unnamed", () => {
    expect(onlyFailure(["not ok 1 - "]).name).toBe("");
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

  test("records both failures when neither carries a block", () => {
    const { failures } = report(["not ok 1 - first", "not ok 2 - second"]);

    expect(failures.map((f) => f.name)).toEqual(["first", "second"]);
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
