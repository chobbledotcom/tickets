import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
/** Deno test flags that take a separate value, which is never a file path. */
export const FILE_ARG_VALUE_FLAGS = new Set([
  "--cert",
  "--config",
  "--conditions",
  "--env-file",
  "--ext",
  "--fail-fast",
  "--filter",
  "--ignore",
  "--junit-path",
  "--location",
  "--minimum-dependency-age",
  "--preload",
  "--require",
  "--seed",
  "--shuffle",
  "--v8-flags",
  "--watch",
  "--watch-exclude",
]);

const TEST_FILE_RE =
  /(^|[/\\])__tests__[/\\].+\.[cm]?[jt]sx?$|(^|[/\\])[^/\\]+(?:[._]test)\.[cm]?[jt]sx?$/;

const TEST_DECLARATION_RE = /(^|[^\w$.])(?:Deno\.test|describe|it|test)\s*\(/g;
const TEST_OBJECT_DECLARATION_RE =
  /(^|[^\w$.])(?:Deno\.test|describe|it|test)\s*\{/g;
const TEST_STEP_RE = /\.\s*step\s*\(/g;

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

const countMatches = (text: string, re: RegExp): number => {
  let count = 0;
  for (const _match of text.matchAll(re)) count++;
  return count;
};

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

export const hasReporterArg = (args: string[]): boolean =>
  args.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="));

const collectFileArgs = (args: string[]): string[] => {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (
        FILE_ARG_VALUE_FLAGS.has(arg) &&
        args[i + 1]?.startsWith("-") === false
      ) {
        i++;
      }
      continue;
    }
    files.push(arg);
  }
  return files;
};

const walkTestFiles = async (path: string, files: string[]): Promise<void> => {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch {
    return;
  }

  if (stat.isFile) {
    if (TEST_FILE_RE.test(path)) files.push(path);
    return;
  }

  if (!stat.isDirectory) return;
  for await (const entry of Deno.readDir(path)) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    await walkTestFiles(`${path}/${entry.name}`, files);
  }
};

export const estimateTapEventCount = async (
  cwd: string,
  args: string[],
): Promise<number | undefined> => {
  const fileArgs = collectFileArgs(args);
  if (fileArgs.length === 0) return;

  const files: string[] = [];
  for (const arg of fileArgs) {
    await walkTestFiles(isAbsolute(arg) ? arg : `${cwd}/${arg}`, files);
  }
  if (files.length === 0) return;

  let count = 0;
  for (const file of files) {
    const text = await Deno.readTextFile(file).catch(() => "");
    count += countMatches(text, TEST_DECLARATION_RE);
    count += countMatches(text, TEST_OBJECT_DECLARATION_RE);
    count += countMatches(text, TEST_STEP_RE);
  }

  return count || undefined;
};

export class CompactTapReporter {
  #cwd: string;
  #estimatedTotal: number;
  #hideProgress: boolean;
  #stdout: (line: string) => void;
  #stderr: (line: string) => void;
  #passed = 0;
  #failed = 0;
  #pendingFailure?: PendingFailure | undefined;
  #diagnosticLines?: string[] | undefined;
  #failures: CompactFailure[] = [];
  #sawTap = false;

  constructor(options: CompactTapReporterOptions) {
    this.#cwd = options.cwd;
    this.#estimatedTotal = options.estimatedTotal ?? 0;
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

const usefulStderr = (stderr: string): string =>
  stderr
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
