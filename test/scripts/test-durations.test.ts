import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bracket } from "#fp";
import {
  formatSlowTestsReport,
  JUNIT_PATH,
  parseJunitDurations,
  readSlowTestsReport,
  SLOW_TEST_THRESHOLD_MS,
  slowTests,
  type TestDuration,
} from "../../scripts/test-durations.ts";

/** Build a minimal JUnit document wrapping the given `<testcase>` fragments. */
const junit = (cases: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="deno test" tests="0" failures="0" errors="0" time="0.0">\n${
    cases
  }\n</testsuites>`;

const testcase = (attrs: Record<string, string>, body = ""): string =>
  `<testcase ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>${body}</testcase>`;

/** Run `body` with a temp file holding `xml`'s content, removed afterwards. */
const withTempJunitFile = bracket(
  () => Deno.makeTempFile({ suffix: ".xml" }),
  (path: string) => Deno.remove(path).catch(() => {}),
);

/** Parse a JUnit doc built from the given `<testcase>` fragments. */
const parseCases = (...cases: string[]): TestDuration[] =>
  parseJunitDurations(junit(cases.join("\n")));

const CASE_QUICK = testcase({
  classname: "test/lib/foo.test.ts",
  line: "3",
  name: "quick test",
  time: "0.001",
});
const CASE_SLOW = testcase({
  classname: "test/lib/foo.test.ts",
  line: "7",
  name: "slow test",
  time: "0.750",
});
const CASE_NESTED = testcase({
  classname: "https://jsr.io/@std/testing/1.0.17/_test_suite.ts",
  line: "171",
  name: "suite &gt; nested",
  time: "0.600",
});
const CASE_FAIL = testcase(
  {
    classname: "test/lib/foo.test.ts",
    line: "12",
    name: "fails",
    time: "0.002",
  },
  '<failure message="boom">boom</failure>',
);
const CASE_SELF_CLOSING = `<testcase name="self closing" classname="test/lib/bar.test.ts" time="0.5" line="1" />`;
const CASE_AT_THRESHOLD = testcase({
  classname: "test/lib/thresh.test.ts",
  line: "1",
  name: "exactly threshold",
  time: "0.500",
});

const PARSED = parseJunitDurations(
  junit([CASE_QUICK, CASE_SLOW, CASE_NESTED, CASE_FAIL].join("\n")),
);

describe("parseJunitDurations", () => {
  test("parses name, file, duration (s→ms), and line from each testcase", () => {
    expect(PARSED).toEqual([
      {
        durationMs: 1,
        file: "test/lib/foo.test.ts",
        line: 3,
        name: "quick test",
      },
      {
        durationMs: 750,
        file: "test/lib/foo.test.ts",
        line: 7,
        name: "slow test",
      },
      {
        durationMs: 600,
        file: "",
        line: 171,
        name: "suite > nested",
      },
      { durationMs: 2, file: "test/lib/foo.test.ts", line: 12, name: "fails" },
    ]);
  });

  test("rounds fractional milliseconds (not truncates/floors)", () => {
    const parsed = parseCases(
      testcase({ classname: "t.ts", line: "1", name: "a", time: "0.001" }),
      testcase({ classname: "t.ts", line: "2", name: "b", time: "0.7509" }),
      testcase({ classname: "t.ts", line: "3", name: "c", time: "0.7504" }),
    );
    expect(parsed.map((d) => d.durationMs)).toEqual([1, 751, 750]);
  });

  test("skips entries with no parseable `time`", () => {
    const parsed = parseCases(
      testcase({ classname: "t.ts", line: "1", name: "no time" }),
      testcase({ classname: "t.ts", line: "2", name: "bad time", time: "n/a" }),
      testcase({ classname: "t.ts", line: "3", name: "ok", time: "0.1" }),
    );
    expect(parsed.map((d) => d.name)).toEqual(["ok"]);
  });

  test("skips entries with no `name`", () => {
    const parsed = parseCases(
      testcase({ classname: "t.ts", line: "1", time: "0.1" }),
      testcase({ classname: "t.ts", line: "2", name: "ok", time: "0.1" }),
    );
    expect(parsed.map((d) => d.name)).toEqual(["ok"]);
  });

  test("handles self-closing testcases", () => {
    const parsed = parseJunitDurations(junit(CASE_SELF_CLOSING));
    expect(parsed).toEqual([
      {
        durationMs: 500,
        file: "test/lib/bar.test.ts",
        line: 1,
        name: "self closing",
      },
    ]);
  });

  test("still parses attrs of a testcase that contains a <failure>", () => {
    const parsed = parseJunitDurations(junit(CASE_FAIL));
    expect(parsed).toEqual([
      { durationMs: 2, file: "test/lib/foo.test.ts", line: 12, name: "fails" },
    ]);
  });

  test("unescapes XML entities in attribute values", () => {
    const parsed = parseJunitDurations(
      junit(
        testcase({
          classname: "t.ts",
          line: "1",
          name: "a &amp; b &gt; c &lt; d &quot;e&quot; &apos;f&apos;",
          time: "0.0",
        }),
      ),
    );
    expect(parsed[0]?.name).toBe(`a & b > c < d "e" 'f'`);
  });

  test("treats internal classnames (ext:/http/node:) as no user file", () => {
    const parsed = parseCases(
      testcase({
        classname: "ext:cli/40_test.js",
        line: "9",
        name: "ext",
        time: "0.1",
      }),
      testcase({
        classname: "https://jsr.io/x/y.ts",
        line: "9",
        name: "http",
        time: "0.1",
      }),
      testcase({
        classname: "node:internal",
        line: "9",
        name: "node",
        time: "0.1",
      }),
      testcase({
        classname: "test/lib/u.test.ts",
        line: "9",
        name: "user",
        time: "0.1",
      }),
    );
    expect(parsed.map((d) => d.file)).toEqual([
      "",
      "",
      "",
      "test/lib/u.test.ts",
    ]);
  });

  test("relativizes an absolute user-file classname under the project root", () => {
    const abs = join(Deno.cwd(), "test/lib/abs.test.ts");
    const parsed = parseJunitDurations(
      junit(testcase({ classname: abs, line: "4", name: "abs", time: "0.1" })),
    );
    expect(parsed[0]?.file).toBe("test/lib/abs.test.ts");
  });

  test("keeps an absolute classname that lives outside the project root as-is", () => {
    const outside = "/absolutely-outside.test.ts";
    const parsed = parseJunitDurations(
      junit(
        testcase({ classname: outside, line: "4", name: "x", time: "0.1" }),
      ),
    );
    expect(parsed[0]?.file).toBe(outside);
  });

  test("sets line to undefined when the testcase has no `line` attr", () => {
    const parsed = parseCases(
      testcase({
        classname: "test/lib/no-line.test.ts",
        name: "noline",
        time: "0.1",
      }),
    );
    expect(parsed[0]?.line).toBeUndefined();
    expect(parsed[0]?.file).toBe("test/lib/no-line.test.ts");
    expect(parsed[0]?.durationMs).toBe(100);
  });

  test("returns [] for empty input", () => {
    expect(parseJunitDurations("")).toEqual([]);
  });
});

describe("slowTests", () => {
  test("keeps only durations strictly over the threshold, slowest first", () => {
    const slow = slowTests(PARSED);
    expect(slow.map((d) => d.name)).toEqual(["slow test", "suite > nested"]);
    expect(slow.map((d) => d.durationMs)).toEqual([750, 600]);
  });

  test("a test at exactly the threshold is not slow (> is strict)", () => {
    const at = parseJunitDurations(junit(CASE_AT_THRESHOLD));
    expect(slowTests(at)).toEqual([]);
    expect(slowTests(at, 499).map((d) => d.name)).toEqual([
      "exactly threshold",
    ]);
  });

  test("threshold defaults to SLOW_TEST_THRESHOLD_MS (500)", () => {
    expect(slowTests(PARSED, SLOW_TEST_THRESHOLD_MS)).toEqual(
      slowTests(PARSED),
    );
  });

  test("threshold 0 surfaces every entry, sorted by duration descending", () => {
    const all = slowTests(PARSED, 0);
    expect(all.map((d) => d.durationMs)).toEqual([750, 600, 2, 1]);
  });

  test("returns [] when nothing is slow", () => {
    expect(slowTests(PARSED, 10_000)).toEqual([]);
  });
});

describe("formatSlowTestsReport", () => {
  test("is empty when nothing exceeds the threshold", () => {
    expect(formatSlowTestsReport(PARSED, 10_000)).toBe("");
  });

  test("lists slow tests slowest-first with duration, name, and location", () => {
    expect(formatSlowTestsReport(PARSED)).toBe(
      [
        "Slow tests (>500ms), slowest first:",
        "",
        "  750ms  slow test  (test/lib/foo.test.ts:7)",
        "  600ms  suite > nested",
      ].join("\n"),
    );
  });

  test("right-aligns durations to the widest entry", () => {
    const durations: TestDuration[] = [
      { durationMs: 1234, file: "a.ts", line: 1, name: "big" },
      { durationMs: 600, file: "b.ts", line: 2, name: "small" },
    ];
    expect(formatSlowTestsReport(durations)).toBe(
      [
        "Slow tests (>500ms), slowest first:",
        "",
        "  1234ms  big  (a.ts:1)",
        "   600ms  small  (b.ts:2)",
      ].join("\n"),
    );
  });

  test("omits location when there is no user file, and when line is absent", () => {
    const durations: TestDuration[] = [
      { durationMs: 700, file: "", name: "no file" },
      { durationMs: 650, file: "c.ts", name: "no line" },
    ];
    expect(formatSlowTestsReport(durations)).toBe(
      [
        "Slow tests (>500ms), slowest first:",
        "",
        "  700ms  no file",
        "  650ms  no line  (c.ts)",
      ].join("\n"),
    );
  });

  test("header reports the threshold actually applied", () => {
    const durations: TestDuration[] = [
      { durationMs: 1000, file: "", name: "x" },
    ];
    expect(formatSlowTestsReport(durations, 999)).toContain(
      "Slow tests (>999ms)",
    );
  });
});

describe("readSlowTestsReport", () => {
  test('returns "" for a missing file', async () => {
    await expect(
      readSlowTestsReport(join(Deno.cwd(), ".does-not-exist-junit.xml")),
    ).resolves.toBe("");
  });

  test("reads, parses, and formats the JUnit file at the given path", async () => {
    await withTempJunitFile(async (path) => {
      await Deno.writeTextFile(path, junit([CASE_SLOW, CASE_QUICK].join("\n")));
      await expect(readSlowTestsReport(path)).resolves.toBe(
        [
          "Slow tests (>500ms), slowest first:",
          "",
          "  750ms  slow test  (test/lib/foo.test.ts:7)",
        ].join("\n"),
      );
    });
  });

  test('returns "" when the file exists but has no slow tests', async () => {
    await withTempJunitFile(async (path) => {
      await Deno.writeTextFile(path, junit(CASE_QUICK));
      await expect(readSlowTestsReport(path)).resolves.toBe("");
    });
  });

  test("JUNIT_PATH points under the project root", () => {
    expect(JUNIT_PATH).toBe(join(Deno.cwd(), ".test-junit.xml"));
  });
});
