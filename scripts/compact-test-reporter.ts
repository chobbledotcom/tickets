import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Location = {
  file: string;
  line?: number;
  column?: number;
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
  location?: Location;
};

export type CompactTapSummary = {
  passed: number;
  failed: number;
  failures: CompactFailure[];
  sawTap: boolean;
};

type CompactTapReporterOptions = {
  cwd: string;
  estimatedTotal?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

const PROGRESS_WIDTH = 24;
const TEST_RESULT_RE = /^\s*(not\s+)?ok\s+\d+(?:\s+-\s+(.*))?$/;
const PLAN_RE = /^\s*\d+\.\.\d+(?:\s+#.*)?$/;
const STEP_FAILURE_RE = /^\d+\s+test\s+steps?\s+failed\.$/;
const REPORTER_FLAGS = new Set(["--reporter"]);
const FILE_ARG_VALUE_FLAGS = new Set([
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

const toDisplayPath = (cwd: string, file: string): string => {
  if (!isAbsolute(file)) return file.replace(/^\.\//, "");
  const rel = relative(cwd, file);
  return rel.startsWith("..") ? file : rel || ".";
};

const locationFromDiagnostic = (
  cwd: string,
  diagnostic: TapDiagnostic,
): Location | undefined => {
  if (!diagnostic.at?.file) return undefined;
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
    const columnSplit = match.lastIndexOf(":");
    const lineSplit = match.lastIndexOf(":", columnSplit - 1);
    if (lineSplit === -1 || columnSplit === -1) continue;

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
  return undefined;
};

export const hasReporterArg = (args: string[]): boolean =>
  args.some(
    (arg, index) =>
      REPORTER_FLAGS.has(arg) ||
      arg.startsWith("--reporter=") ||
      args[index - 1] === "--reporter",
  );

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
  if (fileArgs.length === 0) return undefined;

  const files: string[] = [];
  for (const arg of fileArgs) {
    await walkTestFiles(isAbsolute(arg) ? arg : `${cwd}/${arg}`, files);
  }
  if (files.length === 0) return undefined;

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
  #estimatedTotal?: number;
  #stdout: (line: string) => void;
  #stderr: (line: string) => void;
  #passed = 0;
  #failed = 0;
  #pendingFailure?: PendingFailure;
  #failures: CompactFailure[] = [];
  #sawTap = false;

  constructor(options: CompactTapReporterOptions) {
    this.#cwd = options.cwd;
    this.#estimatedTotal = options.estimatedTotal;
    this.#stdout = options.stdout ?? console.log;
    this.#stderr = options.stderr ?? console.error;
  }

  consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed === "TAP version 14" || PLAN_RE.test(trimmed)) {
      this.#sawTap = true;
      return;
    }

    if (trimmed === "---" || trimmed === "...") return;

    if (this.#pendingFailure && trimmed.startsWith("{")) {
      this.#consumeDiagnostic(trimmed);
      return;
    }

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
    this.#stdout(`ok   ${this.#progress()} ${name}`);
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

  #consumeDiagnostic(line: string): void {
    let diagnostic: TapDiagnostic;
    try {
      diagnostic = JSON.parse(line) as TapDiagnostic;
    } catch {
      this.#flushPendingFailure();
      return;
    }

    const pending = this.#pendingFailure;
    this.#pendingFailure = undefined;
    if (!pending || isStepFailureDiagnostic(diagnostic)) return;

    this.#recordFailure(pending.name, diagnostic);
  }

  #flushPendingFailure(): void {
    const pending = this.#pendingFailure;
    if (!pending) return;

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
    this.#stderr(`fail ${this.#progress()} ${name}`);
    this.#stderr(`     at ${formatLocation(location)}`);
    for (const detailLine of message.split("\n")) {
      this.#stderr(`     ${detailLine}`);
    }
  }

  #progress(): string {
    const done = this.#passed + this.#failed;
    const total = this.#estimatedTotal;
    if (!total) return `[${String(done).padStart(4, " ")} done]`;

    const shownDone = Math.min(done, total);
    const fill = Math.min(
      PROGRESS_WIDTH,
      Math.max(1, Math.round((shownDone / total) * PROGRESS_WIDTH)),
    );
    const bar = `${"#".repeat(fill)}${"-".repeat(PROGRESS_WIDTH - fill)}`;
    const suffix = done > total ? "+" : "";
    return `[${bar}] ${String(done).padStart(
      String(total).length,
      " ",
    )}/${total}${suffix}`;
  }
}

const readLines = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } finally {
    buffered += decoder.decode();
    if (buffered) onLine(buffered);
    reader.releaseLock();
  }
};

const readText = async (
  stream: ReadableStream<Uint8Array>,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
    reader.releaseLock();
  }

  return text;
};

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

  if (extra && (!summary.sawTap || summary.failures.length === 0)) {
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
  });

  const stdoutTask = readLines(child.stdout, (line) =>
    reporter.consumeLine(line),
  );
  const stderrTask = readText(child.stderr);
  const status = await child.status;
  await stdoutTask;
  const stderrText = await stderrTask;
  const summary = reporter.finish();
  printCompactSummary(summary, status.code, stderrText);
  return status.code;
};
