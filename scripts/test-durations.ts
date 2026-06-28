/**
 * Slow-test reporting for the test/precommit runners.
 *
 * `deno test --junit-path` writes a JUnit XML file whose `<testcase>` entries
 * carry per-test timings (in seconds). This module parses that file, flags the
 * tests slower than a threshold, and formats a report.
 *
 * The full runner (`scripts/run-tests.ts`) writes the file and prints the
 * report after a run; the precommit runner surfaces it via the test step's
 * `summary` hook — the step's captured stdout is swallowed on success, so the
 * hook re-reads the JUnit file the subprocess just wrote.
 *
 * Note on Deno's JUnit: a `describe` block emits its own `<testcase>` whose time
 * is the aggregate of its children, plus one `<testcase>` per leaf. Both are
 * kept here: an aggregate points at the source file (its `classname` is the
 * user's test file, while leaf entries inside `describe`/`it` carry Deno
 * internals as `classname`), and a slow leaf names the specific test. Together
 * they locate the slow area without losing either signal — so no test slower
 * than the threshold is ever dropped.
 */
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { filter, mapNotNullish, pipe, sort } from "#fp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");

/** Path both runners agree on for the JUnit XML emitted by `deno test`. */
export const JUNIT_PATH = join(PROJECT_ROOT, ".test-junit.xml");

/** A test is "slow" once it exceeds this many milliseconds. */
export const SLOW_TEST_THRESHOLD_MS = 500;

export type TestDuration = {
  name: string;
  /** Source-relative file when the JUnit `classname` is a user file, else "". */
  file: string;
  durationMs: number;
  line?: number;
};

const TESTCASE_RE = /<testcase\b([^>]*)>/g;

const unescapeXml = (value: string): string =>
  value
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const parseAttrs = (attrs: string): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const match of attrs.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
    map[match[1]!] = unescapeXml(match[2]!);
  }
  return map;
};

const toDurationMs = (time: string | undefined): number | undefined => {
  if (time === undefined) return undefined;
  const seconds = Number.parseFloat(time);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
};

const isUserFile = (classname: string): boolean =>
  !/^(?:ext:|https?:|node:)/.test(classname);

const toDisplayPath = (file: string): string => {
  if (!isAbsolute(file)) return file.replace(/^\.\//, "");
  const rel = relative(PROJECT_ROOT, file);
  return rel.startsWith("..") ? file : rel;
};

/** Parse JUnit XML into per-test durations (one entry per `<testcase>`). */
export const parseJunitDurations = (xml: string): TestDuration[] =>
  mapNotNullish<RegExpMatchArray, TestDuration>((match) => {
    const attrs = parseAttrs(match[1]!);
    const name = attrs.name;
    const durationMs = toDurationMs(attrs.time);
    if (name === undefined || durationMs === undefined) return undefined;
    const classname = attrs.classname;
    const file =
      classname && isUserFile(classname) ? toDisplayPath(classname) : "";
    const lineText = attrs.line;
    const line = lineText ? Number(lineText) : undefined;
    return { durationMs, file, line, name };
  })(xml.matchAll(TESTCASE_RE));

/** Tests slower than `thresholdMs`, slowest first. */
export const slowTests = (
  durations: TestDuration[],
  thresholdMs: number = SLOW_TEST_THRESHOLD_MS,
): TestDuration[] =>
  pipe(
    filter((d: TestDuration) => d.durationMs > thresholdMs),
    sort((a, b) => b.durationMs - a.durationMs),
  )(durations);

const formatLocation = (d: TestDuration): string => {
  if (!d.file) return "";
  const line = d.line ? `:${d.line}` : "";
  return `  (${d.file}${line})`;
};

/** Format the slow-tests report; empty string when nothing exceeds threshold. */
export const formatSlowTestsReport = (
  durations: TestDuration[],
  thresholdMs: number = SLOW_TEST_THRESHOLD_MS,
): string => {
  const slow = slowTests(durations, thresholdMs);
  if (slow.length === 0) return "";
  const width = Math.max(...slow.map((d) => String(d.durationMs).length));
  const lines = slow.map((d) => {
    const ms = String(d.durationMs).padStart(width);
    return `  ${ms}ms  ${d.name}${formatLocation(d)}`;
  });
  return `Slow tests (>${thresholdMs}ms), slowest first:\n\n${lines.join("\n")}`;
};

/** Read + parse + format the JUnit file; "" if missing or no slow tests. */
export const readSlowTestsReport = async (
  junitPath: string = JUNIT_PATH,
  thresholdMs: number = SLOW_TEST_THRESHOLD_MS,
): Promise<string> => {
  const xml = await Deno.readTextFile(junitPath).catch(() => null);
  if (xml === null) return "";
  return formatSlowTestsReport(parseJunitDurations(xml), thresholdMs);
};
