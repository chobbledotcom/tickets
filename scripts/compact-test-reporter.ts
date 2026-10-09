import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "./ansi.ts";
import { nullIfNotFound, rethrowUnlessNotFound } from "./not-found.ts";
import { toDisplayPath } from "./project-root.ts";
import { readStream } from "./stream-lines.ts";
import {
  isStepFailureDiagnostic,
  parseTapDiagnosticBlock,
  type TapDiagnostic,
} from "./tap-diagnostics.ts";

type Location = {
  file: string;
  line?: number | undefined;
  column?: number | undefined;
};

type PendingFailure = {
  name: string;
};

export type CompactFailure = {
  name: string;
  message: string;
  location?: Location | undefined;
};

export type CompactTapSummary = {
  passed: number;
  failed: number;
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

type CompactTapReporterOptions = {
  cwd: string;
  estimatedTotal?: number | undefined;
  hideProgress?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

const PROGRESS_WIDTH = 24;
/** The dying child's own lines land at the end of its output, so the last
 * ones are the cause; the cap keeps a chatty run from flooding the summary. */
const DROPPED_LINE_CAP = 50;
const TEST_RESULT_RE = /^\s*(not\s+)?ok\s+\d+(?:\s+-\s+(.*))?$/;
const PLAN_RE = /^\s*(\d+)\.\.(\d+)(?:\s+#.*)?$/;
const stripTapDirective = (name: string): string =>
  name.replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, "").trim();

const formatLocation = (location?: Location): string =>
  location
    ? `${location.file}${location.line ? `:${location.line}` : ""}${
        location.column ? `:${location.column}` : ""
      }`
    : "unknown location";

const locationFromDiagnostic = (
  cwd: string,
  diagnostic: TapDiagnostic,
): Location | undefined => {
  if (!diagnostic.at?.file) return;
  return {
    column: diagnostic.at.column,
    file: toDisplayPath(cwd, diagnostic.at.file),
    line: diagnostic.at.line,
  };
};

const locationFromStack = (
  cwd: string,
  message: string,
): Location | undefined => {
  const matches = message.match(/file:\/\/[^\s)]+:\d+:\d+/g) ?? [];
  for (const match of matches) {
    // The pattern ends in :line:column, so both colons are always there.
    const columnSplit = match.lastIndexOf(":");
    const lineSplit = match.lastIndexOf(":", columnSplit - 1);

    const url = match.slice(0, lineSplit);
    let file: string;
    try {
      file = fileURLToPath(url);
    } catch {
      continue;
    }

    const rel = relative(cwd, file);
    if (rel.startsWith("..")) continue;

    return {
      column: Number(match.slice(columnSplit + 1)),
      file: rel || ".",
      line: Number(match.slice(lineSplit + 1, columnSplit)),
    };
  }
  return;
};

export class CompactTapReporter {
  #cwd: string;
  #estimatedTotal: number;
  #fileEstimate: number;
  #hideProgress: boolean;
  #stdout: (line: string) => void;
  #stderr: (line: string) => void;
  #passed = 0;
  #failed = 0;
  #pendingFailure?: PendingFailure | undefined;
  #diagnosticLines?: string[] | undefined;
  #failures: CompactFailure[] = [];
  #sawTap = false;
  #lastResultName?: string | undefined;
  #consumedResults = 0;
  #dropped: string[] = [];

  constructor(options: CompactTapReporterOptions) {
    this.#cwd = options.cwd;
    this.#estimatedTotal = options.estimatedTotal ?? 0;
    this.#fileEstimate = this.#estimatedTotal;
    this.#hideProgress = options.hideProgress ?? false;
    this.#stdout = options.stdout ?? console.log;
    this.#stderr = options.stderr ?? console.error;
  }

  consumeLine(line: string): void {
    const trimmed = line.trim();

    if (this.#diagnosticLines) {
      if (trimmed === "...") {
        this.#consumeDiagnosticBlock(this.#diagnosticLines);
        return;
      }
      this.#diagnosticLines.push(line);
      return;
    }

    if (!trimmed) return;

    if (trimmed === "TAP version 14") {
      this.#sawTap = true;
      return;
    }

    const plan = trimmed.match(PLAN_RE);
    if (plan) {
      this.#sawTap = true;
      this.#growEstimatedTotal(Number(plan[2]));
      return;
    }

    if (this.#readDiagnosticBlockStart(trimmed)) return;

    // A TAP comment is stream structure — file names, subtest echoes — not
    // the child's own voice; keeping it would bury the real cause.
    if (trimmed.startsWith("#")) return;

    const result = line.match(TEST_RESULT_RE);
    if (!result) {
      this.#drop(line);
      return;
    }

    this.#consumeResult(result);
  }

  /** A `---` marker under a failed result opens its diagnostic block, which
   * the diagnostic collector ends at `...`. Outside a failure both markers
   * are stream structure and nothing reads them. */
  #readDiagnosticBlockStart(trimmed: string): boolean {
    if (trimmed !== "---" && trimmed !== "...") return false;
    if (trimmed === "---" && this.#pendingFailure) this.#diagnosticLines = [];
    return true;
  }

  #consumeResult(result: RegExpMatchArray): void {
    this.#sawTap = true;
    this.#consumedResults++;
    this.#flushPendingFailure();

    const failed = Boolean(result[1]);
    const name = stripTapDirective(result[2] ?? "(unnamed test)");
    this.#lastResultName = name;
    if (failed) {
      this.#pendingFailure = { name };
      return;
    }

    this.#passed++;
    this.#stdout(this.#formatResultLine("ok  ", name));
  }

  /** Keep a line the TAP grammar does not define for the summary: it is the
   * child's own voice — an error, a panic, or a leak report. */
  #drop(line: string): void {
    this.#dropped.push(line);
    if (this.#dropped.length > DROPPED_LINE_CAP) this.#dropped.shift();
  }

  finish(): CompactTapSummary {
    this.#flushPendingFailure();
    return {
      droppedLines: [...this.#dropped],
      failed: this.#failed,
      failures: [...this.#failures],
      fileEstimate: this.#fileEstimate,
      lastResultName: this.#lastResultName,
      passed: this.#passed,
      sawTap: this.#sawTap,
      suppressedResults: this.#consumedResults - this.#passed - this.#failed,
    };
  }

  #consumeDiagnosticBlock(lines: string[]): void {
    const pending = this.#pendingFailure;
    this.#pendingFailure = undefined;
    this.#diagnosticLines = undefined;

    const diagnostic = parseTapDiagnosticBlock(lines);
    if (!pending || isStepFailureDiagnostic(diagnostic)) return;

    this.#recordFailure(pending.name, diagnostic);
  }

  #flushPendingFailure(): void {
    const pending = this.#pendingFailure;
    if (!pending) return;

    if (this.#diagnosticLines) {
      this.#consumeDiagnosticBlock(this.#diagnosticLines);
      return;
    }

    this.#pendingFailure = undefined;
    this.#recordFailure(pending.name, {
      message: "No TAP diagnostic was emitted for this failure.",
    });
  }

  #recordFailure(name: string, diagnostic: TapDiagnostic): void {
    const message =
      diagnostic.message?.trimEnd() || "No failure message was emitted.";
    const location =
      locationFromStack(this.#cwd, message) ??
      locationFromDiagnostic(this.#cwd, diagnostic);
    const failure: CompactFailure = { location, message, name };

    this.#failed++;
    this.#failures.push(failure);
    this.#stderr(this.#formatResultLine("fail", name));
    this.#stderr(`     at ${formatLocation(location)}`);
    for (const detailLine of message.split("\n")) {
      this.#stderr(`     ${detailLine}`);
    }
  }

  #formatResultLine(prefix: string, name: string): string {
    const progress = this.#progress();
    return progress ? `${prefix} ${progress} ${name}` : `${prefix} ${name}`;
  }

  #growEstimatedTotal(total: number): void {
    if (total <= 0) return;
    this.#estimatedTotal = Math.max(this.#estimatedTotal, total);
  }

  /** A bar and a count; the total grows whenever the run outruns it. */
  #progress(): string {
    if (this.#hideProgress) return "";

    // A result line is what asks for progress, so at least one test is done
    // and growing the total by it always leaves a total of one or more.
    const done = this.#passed + this.#failed;
    this.#growEstimatedTotal(done);
    const total = this.#estimatedTotal;

    const shownDone = Math.min(done, total);
    const fill = Math.min(
      PROGRESS_WIDTH,
      Math.max(1, Math.round((shownDone / total) * PROGRESS_WIDTH)),
    );
    const bar = `${"#".repeat(fill)}${"-".repeat(PROGRESS_WIDTH - fill)}`;
    return `[${bar}] ${String(done).padStart(
      String(total).length,
      " ",
    )}/${total}`;
  }
}

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

const printFailures = (summary: CompactTapSummary): void => {
  if (summary.failures.length === 0) return;
  console.error("\nFailed tests:");
  for (const failure of summary.failures) {
    console.error(`  ${formatLocation(failure.location)} - ${failure.name}`);
  }
};

export const printCompactSummary = (
  summary: CompactTapSummary,
  status: { code: number; signal?: string | null },
  stderrText: string,
  junitErrorFiles: string[] = [],
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

  printFailures(summary);

  // Always surface stderr on a failing run: an uncaught error in a test
  // module (which aborts that module's remaining tests) is only reported
  // here, even when unrelated test failures were also counted.
  if (extra) {
    console.error("\nDeno output:");
    console.error(extra);
  }
};

/** The report path as the harness process sees it: the child writes the
 * report relative to its own working directory, so reads and removals must
 * resolve the path there, not in the parent's. */
const reportFileFor = (options: {
  cwd: string;
  junitPath?: string;
}): string | undefined =>
  options.junitPath === undefined
    ? undefined
    : isAbsolute(options.junitPath)
      ? options.junitPath
      : join(options.cwd, options.junitPath);

export const runCompactDenoTest = async (
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    estimatedTotal?: number;
    junitPath?: string;
  },
): Promise<number> => {
  console.log("Running tests...");
  // A report left by a killed prior run must not name this run's dead files:
  // the child rewrites the report only when it completes.
  const reportFile = reportFileFor(options);
  if (reportFile !== undefined) {
    await Deno.remove(reportFile).catch(rethrowUnlessNotFound);
  }
  const command = new Deno.Command(Deno.execPath(), {
    args,
    cwd: options.cwd,
    env: options.env,
    stderr: "piped",
    stdin: "inherit",
    stdout: "piped",
  });

  const child = command.spawn();
  const reporter = new CompactTapReporter({
    cwd: options.cwd,
    estimatedTotal: options.estimatedTotal,
    hideProgress: Boolean(options.env.CI || options.env.GITHUB_ACTIONS),
  });

  const stdoutTask = readStream(child.stdout, (line) =>
    reporter.consumeLine(line),
  );
  const stderrTask = readStream(child.stderr);
  const status = await child.status;
  await stdoutTask;
  const stderrText = await stderrTask;
  const summary = reporter.finish();
  const junit =
    reportFile === undefined
      ? ""
      : ((await nullIfNotFound(Deno.readTextFile(reportFile))) ?? "");
  printCompactSummary(
    summary,
    { code: status.code, signal: status.signal },
    stderrText,
    junitErrorFiles(junit),
  );
  return status.code;
};
