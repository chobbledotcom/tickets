/** The run summary's printing half: pure data in, console lines out. The
 * TAP reporter produces a `CompactTapSummary`; this module decides what a
 * person reads from a pass, a failure, or a silent exit. Kept apart from
 * the reporter so tests can pin the wording without a TAP stream. */

import { stripAnsi } from "./ansi.ts";

export type Location = {
  file: string;
  line?: number | undefined;
  column?: number | undefined;
};

export type CompactFailure = {
  name: string;
  message: string;
  location?: Location | undefined;
};

/** The message the summary reports when a failed TAP result carried no
 * diagnostic block: the marker that says deno gave no cause for the
 * failure, which is what the JUnit cancellation attribution requires. */
export const NO_TAP_DIAGNOSTIC =
  "No TAP diagnostic was emitted for this failure.";

export type CompactTapSummary = {
  passed: number;
  failed: number;
  /** Results deno reported as skipped (an ignored test), which ran nothing. */
  skipped: number;
  failures: CompactFailure[];
  sawTap: boolean;
  /** Parent results the reporter deliberately dropped because a child step
   * failure already carries the real diagnostic. */
  suppressedResults: number;
  /** The pre-run estimate from the test files' declarations, before any
   * growth the progress bar applied. 0 when the run gave no estimate. */
  fileEstimate: number;
  /** The name of the last result line the output carried. */
  lastResultName?: string | undefined;
  /** Stdout lines the TAP stream carried beside the results — the only place
   * a dying child's own error text can appear. */
  droppedLines: string[];
};

export const formatLocation = (location?: Location): string =>
  location
    ? `${location.file}${location.line ? `:${location.line}` : ""}${
        location.column ? `:${location.column}` : ""
      }`
    : "unknown location";

/** One errored <testcase> deno's JUnit report recorded: the suite the
 * runner cancelled after an uncaught error, at the file and declare site
 * the suite was written at. Deno's TAP output drops an uncaught error's
 * text entirely, so this record is the only attribution the run carries. */
export type JunitErroredTest = {
  column?: number | undefined;
  file: string;
  line?: number | undefined;
  message: string;
  name: string;
};

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/** XML permits code points up to U+10FFFF; anything outside that range
 * stays as the entity text it came from rather than crashing the summary
 * a failing run reads. */
const decodedCodePoint = (code: number, text: string): string =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : text;

const decodeXmlEntities = (value: string): string =>
  value.replace(
    /&(?:#(?<decimal>\d+)|#x(?<hexadecimal>[0-9a-fA-F]+)|(?<word>[A-Za-z][A-Za-z0-9]*));/g,
    (text, decimal, hexadecimal, word) => {
      if (decimal !== undefined) {
        return decodedCodePoint(Number(decimal), text);
      }
      if (hexadecimal !== undefined) {
        return decodedCodePoint(Number.parseInt(hexadecimal, 16), text);
      }
      return XML_ENTITIES[word.toLowerCase()] ?? text;
    },
  );

const ATTRIBUTE_PATTERNS = {
  classname: /\bclassname="([^"]*)"/,
  col: /\bcol="([^"]*)"/,
  line: /\bline="([^"]*)"/,
  message: /\bmessage="([^"]*)"/,
  name: /\bname="([^"]*)"/,
} as const;

type XmlAttribute = keyof typeof ATTRIBUTE_PATTERNS;

/** The decoded attribute value, or "" when the record carries none. */
const xmlAttribute = (tag: string, attribute: XmlAttribute): string =>
  decodeXmlEntities(ATTRIBUTE_PATTERNS[attribute].exec(tag)?.[1] ?? "");

const xmlNumber = (
  tag: string,
  attribute: XmlAttribute,
): number | undefined => {
  const raw = ATTRIBUTE_PATTERNS[attribute].exec(tag)?.[1];
  if (raw === undefined) return;
  const parsed = Number(decodeXmlEntities(raw));
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The errored <testcase> entries in deno's JUnit report, in report order. */
export const junitErroredTests = (junit: string): JunitErroredTest[] => {
  const errored: JunitErroredTest[] = [];
  const testcase = /<testcase\b(?<tag>[^>]*)>(?<body>[\s\S]*?)<\/testcase>/g;
  for (const { groups } of junit.matchAll(testcase)) {
    const { tag, body } = groups as { tag: string; body: string };
    const error = body.match(/<error\b(?<errorTag>[^>]*)>/);
    const errorTag = error?.groups?.errorTag;
    if (errorTag === undefined) continue;
    errored.push({
      column: xmlNumber(tag, "col"),
      file: xmlAttribute(tag, "classname"),
      line: xmlNumber(tag, "line"),
      message: xmlAttribute(errorTag, "message"),
      name: xmlAttribute(tag, "name"),
    });
  }
  return errored;
};

/** Strip the escape sequences, then keep every line Deno's own failure line
 *  does not already cover. */
const usefulStderr = (stderr: string): string =>
  stripAnsi(stderr)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "error: Test failed")
    .join("\n")
    .trim();

/** The test files deno's JUnit report marks with error entries. Deno's TAP
 * reporter drops the text of an uncaught error, but its JUnit report still
 * names the file it aborted, so the summary can point at the entry that was
 * running. */
export const junitErrorFiles = (junit: string): string[] => {
  const names = new Set<string>();
  const suite = /<testsuite\b[^>]*>/g;
  for (const tag of junit.matchAll(suite)) {
    const name = tag[0].match(/\bname="([^"]+)"/)?.[1];
    const errors = tag[0].match(/\berrors="([1-9]\d*)"/)?.[1];
    if (name && errors) names.add(name);
  }
  return [...names];
};

const describeStatus = (status: {
  code: number;
  signal?: string | null;
}): string =>
  status.signal
    ? `deno exited with code ${status.code}, killed by ${status.signal}`
    : `deno exited with code ${status.code}`;

/** The facts about a run that exited non-zero without a failed test: the
 * exit code and signal, the files deno's JUnit report blames, the stdout
 * lines the TAP results carried, and the last result shown. The block reads
 * the child's exit status, the JUnit-blamed files, and the filtered stderr. */
type ExitFacts = {
  summary: CompactTapSummary;
  status: { code: number; signal?: string | null };
  junitErrorFiles: string[];
  extra: string;
};

/** The files deno's JUnit report blames for uncaught errors — the closest
 * marker for a worker death and the failing run's own evidence. */
const printJunitErrorFiles = (junitErrorFiles: string[]): void => {
  if (junitErrorFiles.length === 0) return;
  console.error(
    "\ndeno's JUnit report marks these files with uncaught errors:",
  );
  for (const file of junitErrorFiles) console.error(`  ${file}`);
};

/** The stdout lines deno printed beside the TAP results — a worker or
 * module that aborted prints its only cause there. */
const printRetainedStdout = (droppedLines: readonly string[]): void => {
  if (droppedLines.length === 0) return;
  console.error("\nStdout lines deno printed beside the TAP results:");
  for (const line of droppedLines) console.error(line);
};

const printNoFailedTestFacts = ({
  summary,
  status,
  junitErrorFiles,
  extra,
}: ExitFacts): void => {
  console.error(describeStatus(status));
  printJunitErrorFiles(junitErrorFiles);
  if (
    extra === "" &&
    summary.droppedLines.length === 0 &&
    junitErrorFiles.length === 0
  ) {
    console.error("\ndeno printed no cause for this exit on either stream.");
  }
  const last =
    summary.lastResultName === undefined ? "(none)" : summary.lastResultName;
  console.error(`The last result shown was: ${last}`);
};

/** Deno's TAP output escapes backslashes and hashes in test names; the
 * JUnit record stores the raw name. The comparison accepts both forms. */
const unescapeTapName = (name: string): string =>
  name.replace(/\\([\\#])/g, "$1");

/** The JUnit record for one failure, if it is the attribution the summary
 * may print: the failure must carry no TAP diagnostic (a diagnostic that
 * only lacks a location already says what happened), its name must
 * identify exactly one errored record, and that record must name a file. */
const junitAttribution = (
  failure: CompactFailure,
  errored: JunitErroredTest[],
): JunitErroredTest | undefined => {
  if (failure.location !== undefined || failure.message !== NO_TAP_DIAGNOSTIC) {
    return;
  }
  const matches = errored.filter(
    (test) =>
      test.name === failure.name || test.name === unescapeTapName(failure.name),
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined || match.file === "") return;
  return match;
};

const printFailures = (
  summary: CompactTapSummary,
  errored: JunitErroredTest[],
): void => {
  if (summary.failures.length === 0) return;
  console.error("\nFailed tests:");
  for (const failure of summary.failures) {
    const recorded = junitAttribution(failure, errored);
    const location: Location | undefined = recorded
      ? {
          column: recorded.column,
          file: recorded.file,
          line: recorded.line,
        }
      : failure.location;
    console.error(`  ${formatLocation(location)} - ${failure.name}`);
    if (recorded) {
      console.error(
        `  deno's runner cancelled this suite after an uncaught error. Its JUnit record says "${recorded.message}"; deno's TAP output carries no rejection text.`,
      );
    }
  }
};

export const printCompactSummary = (
  summary: CompactTapSummary,
  status: { code: number; signal?: string | null },
  stderrText: string,
  junitErrorFiles: string[] = [],
  junitErrored: JunitErroredTest[] = [],
): void => {
  const extra = usefulStderr(stderrText);
  // The shortfall counts results that never arrived. A dropped parent
  // summary did arrive — a child step failure already carries the real
  // diagnostic — so it is subtracted like any other reported result.
  const missing =
    summary.fileEstimate -
    summary.passed -
    summary.failed -
    summary.suppressedResults;

  // The declaration count runs both sides of the real result count (it reads
  // fixture strings as declarations and misses loop-generated tests), so it
  // cannot prove a loss on a run the test runner itself called successful.
  if (summary.failed === 0 && status.code === 0) {
    console.log(`\nPASS ${summary.passed} passed`);
    return;
  }

  console.error(`\nFAILED ${summary.passed} passed, ${summary.failed} failed`);

  // A worker or module that aborted beside counted failures prints its only
  // cause as plain stdout, so the retained lines carry evidence on every
  // failing run, not only when no test failure was counted.
  printRetainedStdout(summary.droppedLines);

  if (summary.failed === 0) {
    printNoFailedTestFacts({ extra, junitErrorFiles, status, summary });
  }

  if (missing > 0 && !(summary.failed === 0 && extra !== "")) {
    console.error(
      `The declaration estimate is ${missing} above the results the output reported.`,
    );
  }

  if (summary.failed > 0) printJunitErrorFiles(junitErrorFiles);

  printFailures(summary, junitErrored);

  // Always surface stderr on a failing run: an uncaught error in a test
  // module (which aborts that module's remaining tests) is only reported
  // here, even when unrelated test failures were also counted.
  if (extra) {
    console.error("\nDeno output:");
    console.error(extra);
  }
};
