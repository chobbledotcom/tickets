import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { DEFAULT_DEADLINE, parseArgs } from "#scripts/mutation/args.ts";

describe("parseArgs", () => {
  test("defaults the whole-run deadline to an hour", () => {
    expect(DEFAULT_DEADLINE).toBe(60 * 60_000);
  });

  test("returns defaults for no arguments", () => {
    const parsed = parseArgs([]);
    expect(parsed).toEqual({
      deadline: DEFAULT_DEADLINE,
      error: null,
      exhaustive: false,
      help: false,
      sources: [],
      tests: [],
      useHarness: false,
    });
  });

  test("reads the first two positionals as source then test globs", () => {
    const parsed = parseArgs(["src/a.ts", "test/a.test.ts"]);
    expect(parsed.sources).toEqual(["src/a.ts"]);
    expect(parsed.tests).toEqual(["test/a.test.ts"]);
    expect(parsed.error).toBeNull();
  });

  test("treats a lone positional as the source glob only", () => {
    const parsed = parseArgs(["src/a.ts"]);
    expect(parsed.sources).toEqual(["src/a.ts"]);
    expect(parsed.tests).toEqual([]);
    expect(parsed.error).toBeNull();
  });

  test("reads --source and --test flag form with values", () => {
    const parsed = parseArgs([
      "--source",
      "src/a.ts",
      "--test",
      "test/a.test.ts",
    ]);
    expect(parsed.sources).toEqual(["src/a.ts"]);
    expect(parsed.tests).toEqual(["test/a.test.ts"]);
    expect(parsed.error).toBeNull();
  });

  test("collects repeated --source/--test flags", () => {
    const parsed = parseArgs([
      "--source",
      "a.ts",
      "--source",
      "b.ts",
      "--test",
      "t.ts",
    ]);
    expect(parsed.sources).toEqual(["a.ts", "b.ts"]);
    expect(parsed.tests).toEqual(["t.ts"]);
    expect(parsed.error).toBeNull();
  });

  test("accepts --test-only flag form", () => {
    const parsed = parseArgs(["--test", "t.ts"]);
    expect(parsed.tests).toEqual(["t.ts"]);
    expect(parsed.sources).toEqual([]);
    expect(parsed.error).toBeNull();
  });

  // Regression (PR #1729, item 3): a value flag with no following token used to
  // fall through and be collected as a positional, surfacing later as a
  // misleading "no files matched" glob error. It must now fail fast with a
  // clear usage error and NOT swallow the flag as a value.
  const valueFlags = ["--source", "--test", "--jobs", "--deadline"];
  for (const flag of valueFlags) {
    test(`reports a clear error when ${flag} has no value`, () => {
      const parsed = parseArgs([flag]);
      expect(parsed.error).toBe(`Missing value for ${flag}.`);
      // The flag was not swallowed anywhere as if it were a value.
      expect(parsed.sources).toEqual([]);
      expect(parsed.tests).toEqual([]);
      expect(parsed.batchJobs).toBeUndefined();
      expect(parsed.deadline).toBe(DEFAULT_DEADLINE);
    });
  }

  test("still reads a value flag that does have a following value", () => {
    const parsed = parseArgs(["--source", "src/a.ts", "--test", "t.ts"]);
    expect(parsed.error).toBeNull();
    expect(parsed.sources).toEqual(["src/a.ts"]);
  });

  // A following *option* is not a value — `--source --test t.ts` means the
  // source glob was forgotten, so it must report the missing value rather than
  // swallow `--test` as the source.
  test("treats a following value flag as a missing value", () => {
    const parsed = parseArgs(["--source", "--test", "t.ts"]);
    expect(parsed.error).toBe("Missing value for --source.");
    expect(parsed.sources).toEqual([]);
  });

  test("treats a following boolean flag as a missing value", () => {
    const parsed = parseArgs(["--source", "--exhaustive"]);
    expect(parsed.error).toBe("Missing value for --source.");
  });

  test("keeps the first missing-value error when two flags both lack a value", () => {
    const parsed = parseArgs(["--source", "--test"]);
    expect(parsed.error).toBe("Missing value for --source.");
  });

  // A token that names an Object.prototype member must be an ordinary
  // positional, never a phantom flag — a plain-object lookup would resolve
  // `__proto__`/`constructor`/`toString` to inherited values (and crash when
  // one is invoked as a handler).
  for (const token of ["__proto__", "constructor", "toString"]) {
    test(`treats the prototype-named token ${token} as a positional`, () => {
      const parsed = parseArgs([token, "a.test.ts"]);
      expect(parsed.error).toBeNull();
      expect(parsed.sources).toEqual([token]);
      expect(parsed.tests).toEqual(["a.test.ts"]);
    });
  }

  test("rejects an empty --deadline value instead of reading it as zero", () => {
    const parsed = parseArgs(["--source", "a.ts", "--deadline", ""]);
    expect(parsed.error).toBe(
      "Invalid --deadline: expected a positive number of milliseconds.",
    );
  });

  test("rejects a whitespace-only --jobs value", () => {
    const parsed = parseArgs(["--source", "a.ts", "--jobs", " "]);
    expect(parsed.error).toBe("Invalid --jobs: expected a positive integer.");
  });

  test("sets --exhaustive", () => {
    const parsed = parseArgs(["--exhaustive"]);
    expect(parsed.exhaustive).toBe(true);
  });

  test("does not swallow the token after a boolean flag", () => {
    const parsed = parseArgs(["--exhaustive", "src.ts", "test.ts"]);
    expect(parsed.exhaustive).toBe(true);
    expect(parsed.sources).toEqual(["src.ts"]);
    expect(parsed.tests).toEqual(["test.ts"]);
  });

  test("sets --harness", () => {
    const parsed = parseArgs(["--harness"]);
    expect(parsed.useHarness).toBe(true);
  });

  test("sets help with -h", () => {
    const parsed = parseArgs(["-h"]);
    expect(parsed.help).toBe(true);
  });

  test("sets help with --help", () => {
    const parsed = parseArgs(["--help"]);
    expect(parsed.help).toBe(true);
  });

  test("parses --jobs as a number", () => {
    const parsed = parseArgs([
      "--source",
      "a.ts",
      "--test",
      "t.ts",
      "--jobs",
      "4",
    ]);
    expect(parsed.batchJobs).toBe(4);
    expect(parsed.error).toBeNull();
  });

  test("parses --deadline as a number", () => {
    const parsed = parseArgs([
      "--source",
      "a.ts",
      "--test",
      "t.ts",
      "--deadline",
      "5000",
    ]);
    expect(parsed.deadline).toBe(5000);
    expect(parsed.error).toBeNull();
  });

  test("rejects a zero --deadline, which would stop the run at once", () => {
    const parsed = parseArgs(["--source", "a.ts", "--deadline", "0"]);
    expect(parsed.error).toBe(
      "Invalid --deadline: expected a positive number of milliseconds.",
    );
  });

  test("accepts a --jobs of one as the positive boundary", () => {
    const parsed = parseArgs(["--source", "a.ts", "--jobs", "1"]);
    expect(parsed.batchJobs).toBe(1);
    expect(parsed.error).toBeNull();
  });

  test("rejects a non-integer --jobs", () => {
    const parsed = parseArgs(["--source", "a.ts", "--jobs", "2.5"]);
    expect(parsed.error).toBe("Invalid --jobs: expected a positive integer.");
  });

  test("rejects a non-positive --jobs", () => {
    const parsed = parseArgs(["--source", "a.ts", "--jobs", "0"]);
    expect(parsed.error).toBe("Invalid --jobs: expected a positive integer.");
  });

  test("rejects a negative --deadline", () => {
    const parsed = parseArgs(["--source", "a.ts", "--deadline", "-5"]);
    expect(parsed.error).toBe(
      "Invalid --deadline: expected a positive number of milliseconds.",
    );
  });

  test("rejects a non-numeric --deadline", () => {
    const parsed = parseArgs(["--source", "a.ts", "--deadline", "abc"]);
    expect(parsed.error).toBe(
      "Invalid --deadline: expected a positive number of milliseconds.",
    );
  });

  test("rejects too many positional arguments", () => {
    const parsed = parseArgs(["a.ts", "b.ts", "c.ts"]);
    // Anchored: a bare `.toContain` would still pass if the message were
    // accidentally prefixed (e.g. `error += …` leaving a `null` prefix).
    expect(parsed.error).toMatch(/^Too many positional arguments \(3\)\./);
  });

  test("rejects positionals mixed with --source flag form", () => {
    const parsed = parseArgs(["--source", "a.ts", "x.ts", "y.ts"]);
    expect(parsed.error).toMatch(
      /^Unexpected positional argument\(s\) alongside --source\/--test: x\.ts, y\.ts\./,
    );
    // The advisory middle clause is part of the message, not dropped.
    expect(parsed.error).toContain("A glob likely expanded to multiple files");
  });

  test("rejects positionals mixed with --test flag form", () => {
    const parsed = parseArgs(["--test", "t.ts", "stray.ts"]);
    expect(parsed.error).toMatch(/^Unexpected positional argument\(s\)/);
  });

  test("keeps the first error when a later --deadline is also invalid", () => {
    const parsed = parseArgs(["a.ts", "b.ts", "c.ts", "--deadline", "-5"]);
    expect(parsed.error).toContain("Too many positional arguments (3)");
  });

  test("keeps the first error when a later --jobs is also invalid", () => {
    const parsed = parseArgs(["a.ts", "b.ts", "c.ts", "--jobs", "0"]);
    expect(parsed.error).toContain("Too many positional arguments (3)");
  });

  // A missing value spotted mid-parse must survive the positional pass — the
  // stray-positional and too-many-positional messages must not overwrite it.
  test("keeps a missing-value error over a stray flag-form positional", () => {
    const parsed = parseArgs(["a.ts", "--source", "src.ts", "--jobs"]);
    expect(parsed.error).toBe("Missing value for --jobs.");
  });

  test("keeps a missing-value error over a too-many-positionals error", () => {
    const parsed = parseArgs(["a.ts", "b.ts", "c.ts", "--jobs"]);
    expect(parsed.error).toBe("Missing value for --jobs.");
  });
});
