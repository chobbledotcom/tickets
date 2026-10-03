import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "./ansi.ts";
import { toDisplayPath } from "./project-root.ts";
import { readStream } from "./stream-lines.ts";

type Location = {
  file: string;
  line?: number | undefined;
  column?: number | undefined;
};

type TapDiagnostic = {
  message?: string;
  severity?: string;
  at?: {
    file?: string;
    line?: number;
    column?: number;
  };
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
  /** The pre-run estimate from the test files' declarations, before any
   * growth the progress bar applied. 0 when the run gave no estimate. */
  fileEstimate: number;
  /** The name of the last result line the output carried. */
  lastResultName?: string | undefined;
};

type CompactTapReporterOptions = {
  cwd: string;
  estimatedTotal?: number | undefined;
  hideProgress?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

const PROGRESS_WIDTH = 24;
const TEST_RESULT_RE = /^\s*(not\s+)?ok\s+\d+(?:\s+-\s+(.*))?$/;
const PLAN_RE = /^\s*(\d+)\.\.(\d+)(?:\s+#.*)?$/;
const STEP_FAILURE_RE = /^\d+\s+test\s+steps?\s+failed\.$/;
const stripTapDirective = (name: string): string =>
  name.replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, "").trim();

const leadingWhitespaceLength = (line: string): number =>
  line.match(/^\s*/)?.[0].length ?? 0;

const stripCommonIndent = (lines: string[]): string => {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map(leadingWhitespaceLength);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(indent)).join("\n");
};

const parseYamlScalar = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const readYamlBlockScalar = (
  lines: string[],
  startIndex: number,
  baseIndent: number,
): string => {
  const block: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const indent = leadingWhitespaceLength(line);
    if (line.trim() && indent <= baseIndent && /^\w[\w-]*:/.test(line.trim())) {
      break;
    }
    block.push(line);
  }
  return stripCommonIndent(block).trimEnd();
};

const parseYamlMessage = (lines: string[]): string | undefined => {
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(/^(\s*)message:\s*(.*)$/);
    if (!match) continue;
    const value = match[2]?.trim() ?? "";
    const baseIndent = (match[1] ?? "").length;
    return value.startsWith("|") || value.startsWith(">")
      ? readYamlBlockScalar(lines, index, baseIndent)
      : parseYamlScalar(value);
  }
  return;
};

type AtFieldAssign = (
  at: NonNullable<TapDiagnostic["at"]>,
  value: string,
) => void;

const AT_FIELD_ASSIGNERS: Record<string, AtFieldAssign | undefined> = {
  column: (at, value) => {
    at.column = Number(value);
  },
  file: (at, value) => {
    at.file = value;
  },
  line: (at, value) => {
    at.line = Number(value);
  },
};

const assignAtField = (
  at: NonNullable<TapDiagnostic["at"]>,
  key: string,
  value: string,
): void => {
  AT_FIELD_ASSIGNERS[key]?.(at, value);
};

const parseYamlAt = (lines: string[]): TapDiagnostic["at"] | undefined => {
  const atIndex = lines.findIndex((line) => /^(\s*)at:\s*$/.test(line));
  if (atIndex === -1) return;

  const atIndent = leadingWhitespaceLength(lines[atIndex] ?? "");
  const at: NonNullable<TapDiagnostic["at"]> = {};
  for (const line of lines.slice(atIndex + 1)) {
    if (line.trim() && leadingWhitespaceLength(line) <= atIndent) break;
    const match = line.match(/^\s*(file|line|column):\s*(.*)$/);
    if (!match) continue;
    assignAtField(at, match[1] ?? "", parseYamlScalar(match[2] ?? ""));
  }
  return at;
};

const parseYamlTapDiagnostic = (text: string): TapDiagnostic | undefined => {
  const lines = text.split(/\r?\n/);
  const diagnostic: TapDiagnostic = {};

  const message = parseYamlMessage(lines);
  if (message !== undefined) diagnostic.message = message;

  const at = parseYamlAt(lines);
  if (at !== undefined) diagnostic.at = at;

  return diagnostic.message || diagnostic.at ? diagnostic : undefined;
};

const parseTapDiagnosticBlock = (lines: string[]): TapDiagnostic => {
  const text = stripCommonIndent(lines).trimEnd();
  const trimmed = text.trim();
  if (!trimmed) {
    return { message: "No TAP diagnostic was emitted for this failure." };
  }

  try {
    return JSON.parse(trimmed) as TapDiagnostic;
  } catch {
    return parseYamlTapDiagnostic(text) ?? { message: text };
  }
};

const isStepFailureDiagnostic = (diagnostic: TapDiagnostic): boolean =>
  STEP_FAILURE_RE.test((diagnostic.message ?? "").trim());

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

    if (this.#pendingFailure && trimmed === "---") {
      this.#diagnosticLines = [];
      return;
    }

    if (trimmed === "---" || trimmed === "...") return;

    const result = line.match(TEST_RESULT_RE);
    if (!result) return;

    this.#sawTap = true;
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

  finish(): CompactTapSummary {
    this.#flushPendingFailure();
    return {
      failed: this.#failed,
      failures: [...this.#failures],
      fileEstimate: this.#fileEstimate,
      lastResultName: this.#lastResultName,
      passed: this.#passed,
      sawTap: this.#sawTap,
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

export const printCompactSummary = (
  summary: CompactTapSummary,
  exitCode: number,
  stderrText: string,
): void => {
  const extra = usefulStderr(stderrText);

  if (summary.failed === 0 && exitCode === 0) {
    console.log(`\nPASS ${summary.passed} passed`);
    return;
  }

  console.error(`\nFAILED ${summary.passed} passed, ${summary.failed} failed`);

  // Zero counted failures on a non-zero exit, with nothing reported on
  // stderr, means a worker died and the tests it still held never reported;
  // a load error would stand on stderr instead. The TAP stream names no
  // worker, so the last result is the closest marker the output holds.
  if (summary.failed === 0 && extra === "") {
    console.error(
      "\nA test worker probably died, and the tests it still held did not report.",
    );
    const missing = summary.fileEstimate - summary.passed - summary.failed;
    if (missing > 0) {
      console.error(
        `${missing} of the ${summary.fileEstimate} expected tests did not report.`,
      );
    }
    const last =
      summary.lastResultName === undefined ? "(none)" : summary.lastResultName;
    console.error(`The last result shown was: ${last}`);
    console.error(
      "If this repeats, rerun with fewer workers, for example DENO_JOBS=4.",
    );
  }

  if (summary.failures.length > 0) {
    console.error("\nFailed tests:");
    for (const failure of summary.failures) {
      console.error(`  ${formatLocation(failure.location)} - ${failure.name}`);
    }
  }

  // Always surface stderr on a failing run: an uncaught error in a test
  // module (which aborts that module's remaining tests) is only reported
  // here, even when unrelated test failures were also counted.
  if (extra) {
    console.error("\nDeno output:");
    console.error(extra);
  }
};

export const runCompactDenoTest = async (
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    estimatedTotal?: number;
  },
): Promise<number> => {
  console.log("Running tests...");
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
  printCompactSummary(summary, status.code, stderrText);
  return status.code;
};
