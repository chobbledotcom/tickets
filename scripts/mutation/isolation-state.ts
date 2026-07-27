/**
 * Pure-ish state and filesystem helpers for isolated mutation runs.
 *
 * The process supervisor lives in isolation.ts; this module holds the small
 * rules that are cheap to unit-test directly.
 */

import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { openLockFile } from "#scripts/lock-file.ts";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { denoExitCode } from "./child-process.ts";

export const MUTATION_RUNS_DIR = ".mutation-runs";
export const MUTATION_WORK_DIR = "work";
export const MUTATION_RECORD_FILE = "run.json";
export const MUTATION_RUN_LOCK_FILE = "run.lock";
export const MUTATION_SNAPSHOT_CHILD_ENV = "TICKETS_MUTATION_SNAPSHOT_CHILD";
export const MUTATION_RUN_ID_ENV = "TICKETS_MUTATION_RUN_ID";
export const MUTATION_RUN_ROOT_ENV = "TICKETS_MUTATION_RUN_ROOT";
export const MUTATION_WORK_ROOT_ENV = "TICKETS_MUTATION_WORK_ROOT";

const SKIPPED_TOP_LEVEL_NAMES = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".deno",
  ".deno-cache",
  ".deno_cache",
  ".direnv",
  ".do",
  ".git",
  ".i18n-work",
  ".local-data",
  ".mutation-runs",
  ".pi-worktrees",
  "cov",
  "cov_profile",
  "dist",
  "docs-output",
  "misc",
  "node_modules",
  "undefined",
  "null",
]);

const SKIPPED_TOP_LEVEL_PREFIXES = ["coverage", ".jscpd", "docs-output"];

const SKIPPED_FILE_NAMES = new Set([
  ".build-tag",
  ".db-key",
  ".env",
  // Describes the assets of the checkout it was written in, which this copy
  // deliberately leaves behind — carrying it over would claim a build that is
  // not there.
  ".static-assets-cache.json",
  ".static-assets-build.lock",
  ".test-junit.xml",
  "bunny-script.ts",
  "bunny-script.ts.map",
  "tickets.db",
]);

export type MutationRunStatus =
  | "copying"
  | "running"
  | "passed"
  | "failed"
  | "interrupted";

export interface MutationRunRecord {
  args: string[];
  createdAt: string;
  exitCode?: number;
  id: string;
  pid?: number;
  root: string;
  status: MutationRunStatus;
  updatedAt: string;
  workRoot: string;
}

export type IsolationCommand =
  | { kind: "clean"; target: string }
  | { kind: "help" }
  | { kind: "invalid"; message: string }
  | { kind: "kill"; force: boolean; target: string }
  | { kind: "list" }
  | { args: string[]; kind: "run" };

export const ISOLATION_USAGE = `Usage:
  deno task mutation <source-glob> <test-glob> [mutation options]
  deno task mutation --list
  deno task mutation --kill <run-id|all> [--force]
  deno task mutation --clean <run-id|all|finished>

Mutation runs are copied to .mutation-runs/<run-id>/work first. The normal
in-place mutation engine then runs inside that copy, so live source files are
not touched. The copy is deleted when the run ends, and anything a stopped run
left behind is deleted when the next run starts.`;

const nowIso = (): string => new Date().toISOString();

const pathParts = (path: string): string[] =>
  path.split(/[\\/]+/).filter((part) => part.length > 0);

const slashPath = (path: string): string => pathParts(path).join("/");

const isDatabaseFile = (name: string): boolean =>
  name.endsWith(".db") || name.endsWith(".db-shm") || name.endsWith(".db-wal");

const isGeneratedStaticAsset = (relativePath: string): boolean =>
  relativePath.startsWith("src/ui/static/") &&
  (relativePath.endsWith(".js") || relativePath === "src/ui/static/style.css");

export const shouldCopySnapshotPath = (relativePath: string): boolean => {
  const parts = pathParts(relativePath);
  const top = parts[0];
  const name = parts.at(-1);
  if (!top || !name) return true;
  if (SKIPPED_TOP_LEVEL_NAMES.has(top)) return false;
  if (SKIPPED_TOP_LEVEL_PREFIXES.some((prefix) => top.startsWith(prefix))) {
    return false;
  }
  if (SKIPPED_FILE_NAMES.has(name) || isDatabaseFile(name)) return false;
  return !isGeneratedStaticAsset(slashPath(relativePath));
};

const copyDirectory = async (
  fromRoot: string,
  toRoot: string,
  relativePath = "",
): Promise<void> => {
  const fromDir = join(fromRoot, relativePath);
  const toDir = join(toRoot, relativePath);
  await Deno.mkdir(toDir, { recursive: true });

  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(fromDir)) entries.push(entry);

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childPath = relativePath
      ? join(relativePath, entry.name)
      : entry.name;
    if (!shouldCopySnapshotPath(childPath)) continue;

    const from = join(fromRoot, childPath);
    const to = join(toRoot, childPath);
    if (entry.isDirectory) {
      await copyDirectory(fromRoot, toRoot, childPath);
    } else {
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.copyFile(from, to);
    }
  }
};

export const copyMutationSnapshot = async (
  fromRoot: string,
  toRoot: string,
): Promise<void> => {
  await Deno.mkdir(toRoot, { recursive: true });
  await copyDirectory(fromRoot, toRoot);
};

const compactIso = (iso: string): string =>
  iso
    .replaceAll(":", "")
    .replaceAll("-", "")
    .replace(/\.\d+Z$/, "Z");

export const createRunId = (
  date = new Date(),
  suffix = crypto.randomUUID().slice(0, 8),
): string => `mutation-${compactIso(date.toISOString())}-${suffix}`;

export const runsRoot = (root = projectRoot): string =>
  join(root, MUTATION_RUNS_DIR);

export const runRoot = (id: string, root = projectRoot): string =>
  join(runsRoot(root), id);

/** Path to a named child (dir or file) inside a run's own folder. */
const runChildPath =
  (childName: string) =>
  (id: string, root = projectRoot): string =>
    join(runRoot(id, root), childName);

export const workRoot = runChildPath(MUTATION_WORK_DIR);

export const recordPath = runChildPath(MUTATION_RECORD_FILE);

export const runLockPath = (record: Pick<MutationRunRecord, "root">): string =>
  join(record.root, MUTATION_RUN_LOCK_FILE);

export const newRunRecord = (
  id: string,
  args: string[],
  root = projectRoot,
  createdAt = nowIso(),
): MutationRunRecord => ({
  args,
  createdAt,
  id,
  root: runRoot(id, root),
  status: "copying",
  updatedAt: createdAt,
  workRoot: workRoot(id, root),
});

export const statusForExitCode = (code: number): MutationRunStatus =>
  code === 0 ? "passed" : code === 130 ? "interrupted" : "failed";

export const markRunning = (
  record: MutationRunRecord,
  pid: number,
  updatedAt = nowIso(),
): MutationRunRecord => ({
  ...record,
  pid,
  status: "running",
  updatedAt,
});

export const markFinished = (
  record: MutationRunRecord,
  exitCode: number,
  updatedAt = nowIso(),
): MutationRunRecord => ({
  ...record,
  exitCode,
  status: statusForExitCode(exitCode),
  updatedAt,
});

export const markInterrupted = (
  record: MutationRunRecord,
  updatedAt = nowIso(),
): MutationRunRecord => ({
  ...record,
  exitCode: 130,
  status: "interrupted",
  updatedAt,
});

export const isTerminalRunStatus = (status: MutationRunStatus): boolean =>
  status === "passed" || status === "failed" || status === "interrupted";

/**
 * How long after a run is marked "running" we still treat it as active for
 * cleanup, even if the child has not acquired the run lock yet. This covers
 * the startup window between `spawn()` and the child taking the lock. After
 * it expires, a running record with a live PID but no lock is stale (the PID
 * may have been reused by an unrelated process) and can be cleaned.
 */
export const RUN_STARTUP_GRACE_MS = 30_000;

/** Was `at` within the startup grace? Unknown times count as long ago. */
export const withinStartupGrace = (
  at: number,
  now: Date = new Date(),
  graceMs: number = RUN_STARTUP_GRACE_MS,
): boolean => at > 0 && now.getTime() - at < graceMs;

export const runStartedRecently = (
  record: MutationRunRecord,
  now?: Date,
): boolean => withinStartupGrace(Date.parse(record.updatedAt), now);

export const writeRunRecord = async (
  record: MutationRunRecord,
): Promise<void> => {
  await Deno.mkdir(dirname(join(record.root, MUTATION_RECORD_FILE)), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(record.root, MUTATION_RECORD_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  );
};

export const readRunRecord = async (
  path: string,
): Promise<MutationRunRecord | null> => {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as MutationRunRecord;
  } catch {
    return null;
  }
};

const recordInCurrentRunDirectory = (
  record: MutationRunRecord,
  id: string,
  root = projectRoot,
): MutationRunRecord => ({
  ...record,
  id,
  root: runRoot(id, root),
  workRoot: workRoot(id, root),
});

/** Every run folder, whether or not it still holds a readable record. */
export const runDirectoryNames = async (
  root = projectRoot,
): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(runsRoot(root))) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
  return names;
};

export const readRunRecords = async (
  root = projectRoot,
): Promise<MutationRunRecord[]> => {
  const records: MutationRunRecord[] = [];
  for (const name of await runDirectoryNames(root)) {
    const record = await readRunRecord(recordPath(name, root));
    if (record) records.push(recordInCurrentRunDirectory(record, name, root));
  }
  return records.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
};

const withTrailingSeparator = (path: string): string =>
  path.endsWith(SEPARATOR) ? path : `${path}${SEPARATOR}`;

export const rewriteProjectPathArg = (
  root: string,
  snapshotRoot: string,
  value: string,
): string => {
  if (!isAbsolute(value)) return value;
  const resolvedRoot = resolve(root);
  const resolvedSnapshot = resolve(snapshotRoot);
  const resolvedValue = resolve(value);
  if (resolvedValue === resolvedRoot) return resolvedSnapshot;
  const rootPrefix = withTrailingSeparator(resolvedRoot);
  if (!resolvedValue.startsWith(rootPrefix)) return value;
  return join(resolvedSnapshot, resolvedValue.slice(rootPrefix.length));
};

/** Turn a run's arguments into the ones the child sees inside its snapshot. */
export type SnapshotArgsFn = (
  root: string,
  snapshotRoot: string,
  args: string[],
) => string[];

export const rewriteMutationArgs: SnapshotArgsFn = (root, snapshotRoot, args) =>
  args.map((arg) => rewriteProjectPathArg(root, snapshotRoot, arg));

export const parseIsolationCommand = (args: string[]): IsolationCommand => {
  const [first, second, ...rest] = args;
  if (!first) {
    return {
      kind: "invalid",
      message: "Mutation source and test globs are required.",
    };
  }
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "list" || first === "--list") return { kind: "list" };
  if (first === "kill" || first === "--kill") {
    return second
      ? { force: rest.includes("--force"), kind: "kill", target: second }
      : { kind: "invalid", message: "A run id or all is required for --kill." };
  }
  if (first === "clean" || first === "--clean") {
    return second
      ? { kind: "clean", target: second }
      : {
          kind: "invalid",
          message: "A run id, all, or finished is required for --clean.",
        };
  }
  return { args, kind: "run" };
};

export const visibleStatus = (
  record: MutationRunRecord,
  isAlive: boolean,
): MutationRunStatus | "stale" =>
  record.status === "running" && !isAlive ? "stale" : record.status;

export const formatRunLine = (
  record: MutationRunRecord,
  isAlive: boolean,
  root = projectRoot,
): string => {
  const status = visibleStatus(record, isAlive);
  const pid = record.pid === undefined ? "pid=-" : `pid=${record.pid}`;
  const exit =
    record.exitCode === undefined ? "exit=-" : `exit=${record.exitCode}`;
  const work = relative(root, record.workRoot);
  const args = record.args.length === 0 ? "" : ` args=${record.args.join(" ")}`;
  return `${record.id} ${status} ${pid} ${exit} work=${work}${args}`;
};

export const formatRunList = (
  records: MutationRunRecord[],
  liveRunIds: Set<string>,
  root = projectRoot,
): string[] =>
  records.length === 0
    ? ["No isolated mutation runs."]
    : records.map((record) =>
        formatRunLine(record, liveRunIds.has(record.id), root),
      );

const LOCK_HELD_EXIT_CODE = 124;

const LOCK_PROBE_SCRIPT = `
const [path, timeoutText] = Deno.args;
const timeout = setTimeout(
  () => Deno.exit(${LOCK_HELD_EXIT_CODE}),
  Number(timeoutText),
);
const file = await Deno.open(path, { read: true, write: true }).catch(() => null);
if (file === null) {
  clearTimeout(timeout);
  Deno.exit(2);
}
try {
  await file.lock(true);
  await file.unlock();
  clearTimeout(timeout);
  file.close();
  Deno.exit(0);
} catch {
  clearTimeout(timeout);
  file.close();
  Deno.exit(2);
}
`;

const lockProbeExitCode = (path: string, timeoutMs: number): Promise<number> =>
  denoExitCode(["eval", LOCK_PROBE_SCRIPT, "--", path, String(timeoutMs)], {
    stderr: "null",
    stdout: "null",
  });

export const runLockIsHeld = async (
  record: Pick<MutationRunRecord, "root">,
  timeoutMs = 50,
): Promise<boolean> => {
  const path = runLockPath(record);
  const file = await openLockFile(path).catch(() => null);
  if (file === null) return false;
  file.close();
  return (await lockProbeExitCode(path, timeoutMs)) === LOCK_HELD_EXIT_CODE;
};

export const withMutationRunLock = async <Result>(
  runRootPath: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  await Deno.mkdir(runRootPath, { recursive: true });
  const file = await openLockFile(join(runRootPath, MUTATION_RUN_LOCK_FILE));
  try {
    await file.lock(true);
    return await run();
  } finally {
    await file.unlock();
    file.close();
  }
};

export const selectedRuns = (
  records: MutationRunRecord[],
  target: string,
): MutationRunRecord[] => {
  if (target === "all") return records;
  if (target === "finished") {
    return records.filter((record) => isTerminalRunStatus(record.status));
  }
  const exact = records.filter((record) => record.id === target);
  if (exact.length > 0) return exact;
  const prefixed = records.filter((record) => record.id.startsWith(target));
  return prefixed.length === 1 ? prefixed : [];
};
