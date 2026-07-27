/**
 * Side-effecting supervisor for isolated mutation runs.
 *
 * It copies the checkout, starts the normal mutation script inside that copy,
 * and manages list/kill/clean commands for `.mutation-runs/`.
 */

import { relative } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import {
  INHERIT_STDIO,
  processExists,
  removeTree,
  stopProcess,
  stopProcessNow,
} from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/termination-signals.ts";
import { errorMessage } from "#shared/error-message.ts";
import { envWith } from "./child-process.ts";
import {
  copyMutationSnapshot,
  createRunId,
  formatRunList,
  ISOLATION_USAGE,
  isTerminalRunStatus,
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_WORK_ROOT_ENV,
  type MutationRunRecord,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  readRunRecords,
  rewriteMutationArgs,
  runDirectoryNames,
  runLockIsHeld,
  runRoot,
  runStartedRecently,
  type SnapshotArgsFn,
  selectedRuns,
  withinStartupGrace,
  withMutationRunLock,
  writeRunRecord,
} from "./isolation-state.ts";

/** Runs a mutation command from its argv and returns a process exit code. */
type MutationCommandRunner = (args: string[], root?: string) => Promise<number>;

const processBelongsToRun = async (
  record: MutationRunRecord,
): Promise<boolean> => {
  if (record.status !== "running" || record.pid === undefined) return false;
  if (!processExists(record.pid)) return false;
  return await runLockIsHeld(record);
};

/**
 * A run that is still copying counts as active while it is young, even before
 * its lock shows: a run writes its record moments before it takes the lock, and
 * deleting its folder in that gap would pull the snapshot out from under it.
 */
const copyingRunStillActive = async (
  record: MutationRunRecord,
): Promise<boolean> =>
  record.status === "copying" &&
  (runStartedRecently(record) || (await runLockIsHeld(record)));

const runningProcessStillExists = async (
  record: MutationRunRecord,
): Promise<boolean> =>
  record.status === "running" &&
  record.pid !== undefined &&
  processExists(record.pid) &&
  (runStartedRecently(record) || (await runLockIsHeld(record)));

const liveRunIdSet = async (
  records: MutationRunRecord[],
): Promise<Set<string>> => {
  const live = await Promise.all(
    records.map(async (record) => {
      if (record.pid === undefined) return null;
      return (await processBelongsToRun(record)) ? record.id : null;
    }),
  );
  return new Set(live.filter((id): id is string => id !== null));
};

type RemoveRunResult =
  | { record: MutationRunRecord; removed: true }
  | { error: unknown; record: MutationRunRecord; removed: false };

/** Delete one folder of a run, treating an already-missing folder as done. */
const removeRunPath = async (
  record: MutationRunRecord,
  path: string,
): Promise<RemoveRunResult> => {
  try {
    await removeTree(path);
    return { record, removed: true };
  } catch (error) {
    const missing = error instanceof Deno.errors.NotFound;
    return missing
      ? { record, removed: true }
      : { error, record, removed: false };
  }
};

const removeRun = (record: MutationRunRecord): Promise<RemoveRunResult> =>
  removeRunPath(record, record.root);

const cleanableRuns = async (
  records: MutationRunRecord[],
): Promise<{
  removable: MutationRunRecord[];
  skipped: MutationRunRecord[];
}> => {
  const statuses = await Promise.all(
    records.map(async (record) => ({
      isActive:
        (await copyingRunStillActive(record)) ||
        (await runningProcessStillExists(record)),
      record,
    })),
  );
  return {
    removable: statuses
      .filter(({ isActive }) => !isActive)
      .map(({ record }) => record),
    skipped: statuses
      .filter(({ isActive }) => isActive)
      .map(({ record }) => record),
  };
};

const reportRemoveFailure = (
  what: string,
  { error, record }: Extract<RemoveRunResult, { removed: false }>,
): void => {
  console.error(`Failed to remove ${what}${record.id}: ${errorMessage(error)}`);
};

/** Drops the snapshot of a run that has ended: it is a whole checkout copy. */
const removeWorkSnapshot = async (record: MutationRunRecord): Promise<void> => {
  const result = await removeRunPath(record, record.workRoot);
  if (!result.removed) reportRemoveFailure("the snapshot of ", result);
};

/** When a folder last changed, or 0 when that cannot be told. */
const folderChangedAt = async (path: string): Promise<number> => {
  const info = await Deno.stat(path).catch((error: unknown) => {
    rethrowUnlessNotFound(error);
    return null;
  });
  return info?.mtime?.getTime() ?? 0;
};

/**
 * A folder whose record cannot be read belongs to a run that was killed while
 * writing it. Stand in for that record so the folder can be checked and
 * cleared like any other.
 */
const recordForUnreadableRun = async (
  id: string,
  root: string,
): Promise<MutationRunRecord> => {
  const changedAt = await folderChangedAt(runRoot(id, root));
  return {
    ...newRunRecord(id, [], root),
    // Young folders are left alone, in case a run is writing its record now.
    updatedAt: withinStartupGrace(changedAt)
      ? new Date().toISOString()
      : new Date(0).toISOString(),
  };
};

const runsToSweep = async (root: string): Promise<MutationRunRecord[]> => {
  const records = await readRunRecords(root);
  const known = new Set(records.map((record) => record.id));
  const unreadable = (await runDirectoryNames(root)).filter(
    (name) => !known.has(name),
  );
  return [
    ...records,
    ...(await Promise.all(
      unreadable.map((id) => recordForUnreadableRun(id, root)),
    )),
  ];
};

/** Clears out whatever earlier runs left behind, so nothing piles up. */
const removeInactiveRuns = async (root: string): Promise<void> => {
  const { removable } = await cleanableRuns(await runsToSweep(root));
  const results = await Promise.all(removable.map(removeRun));
  for (const result of results) {
    if (!result.removed) reportRemoveFailure("the earlier run ", result);
  }
};

const signalRun = async (
  record: MutationRunRecord,
  force: boolean,
): Promise<boolean> => {
  if (!(await processBelongsToRun(record)) || record.pid === undefined) {
    return false;
  }
  try {
    Deno.kill(record.pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
};

const childEnv = (
  id: string,
  runRootPath: string,
  snapshotRoot: string,
): Record<string, string> =>
  envWith({
    [MUTATION_SNAPSHOT_CHILD_ENV]: "1",
    [MUTATION_RUN_ID_ENV]: id,
    [MUTATION_RUN_ROOT_ENV]: runRootPath,
    [MUTATION_WORK_ROOT_ENV]: snapshotRoot,
  });

const childArgs: SnapshotArgsFn = (root, snapshotRoot, args) => [
  "run",
  "-A",
  "scripts/mutation.ts",
  ...rewriteMutationArgs(root, snapshotRoot, args),
];

const forceStopChild = (child: Deno.ChildProcess | null): never => {
  if (child) stopProcessNow(child);
  Deno.exit(130);
};

const killChildQuietly = (child: Deno.ChildProcess | null): void => {
  if (!child) return;
  try {
    child.kill();
  } catch {
    // It may already have exited.
  }
};

const settleRecord = (
  record: MutationRunRecord,
  interrupted: boolean,
  code: number,
): MutationRunRecord =>
  interrupted ? markInterrupted(record) : markFinished(record, code);

export const runMutationInSnapshot: MutationCommandRunner = async (
  args,
  root = projectRoot,
) => {
  await removeInactiveRuns(root);
  const id = createRunId();
  let record = newRunRecord(id, args, root);
  await writeRunRecord(record);

  let child: Deno.ChildProcess | null = null;
  let interrupted = false;
  const stopChild = (): void => {
    if (interrupted) forceStopChild(child);
    interrupted = true;
    killChildQuietly(child);
  };
  onTerminationSignals(stopChild);

  let exitCode = 1;
  try {
    console.log(`Creating isolated mutation run ${id}`);
    console.log(`Snapshot: ${relative(root, record.workRoot)}`);
    child = await withMutationRunLock(record.root, async () => {
      // A `--clean` running in the gap above sees an unlocked copying run and
      // removes it, so write the record again now the lock makes it safe.
      await writeRunRecord(record);
      await copyMutationSnapshot(root, record.workRoot);
      if (interrupted) {
        record = markInterrupted(record);
        await writeRunRecord(record);
        exitCode = 130;
        return null;
      }
      const spawned = new Deno.Command(Deno.execPath(), {
        args: childArgs(root, record.workRoot, args),
        cwd: record.workRoot,
        env: childEnv(id, record.root, record.workRoot),
        ...INHERIT_STDIO,
      }).spawn();
      child = spawned;
      record = markRunning(record, spawned.pid);
      await writeRunRecord(record);
      console.log(`Mutation child pid ${spawned.pid}`);
      return spawned;
    });

    if (child !== null) {
      const status = await child.status;
      record = settleRecord(record, interrupted, status.code);
      await writeRunRecord(record);
      exitCode = interrupted ? 130 : status.code;
    }
  } catch (error) {
    if (child !== null) await stopProcess(child, 250);
    exitCode = interrupted ? 130 : 1;
    record = settleRecord(record, interrupted, exitCode);
    try {
      await writeRunRecord(record);
    } catch {
      // A failed write should not mask the original error.
    }
    console.error(errorMessage(error));
  }
  offTerminationSignals(stopChild);
  if (isTerminalRunStatus(record.status)) await removeWorkSnapshot(record);
  return exitCode;
};

const listRuns = async (root = projectRoot): Promise<number> => {
  const records = await readRunRecords(root);
  const liveRunIds = await liveRunIdSet(records);
  for (const line of formatRunList(records, liveRunIds, root)) {
    console.log(line);
  }
  return 0;
};

/** Run `body` over the runs matching `target`, or report + return 1 if none. */
const withSelectedRuns = async (
  target: string,
  root: string,
  body: (records: MutationRunRecord[]) => Promise<number>,
): Promise<number> => {
  const records = selectedRuns(await readRunRecords(root), target);
  if (records.length === 0) {
    console.error(`No isolated mutation run matched ${target}.`);
    return 1;
  }
  return body(records);
};

const signalMatchedRuns = async (
  records: MutationRunRecord[],
  force: boolean,
  target: string,
): Promise<number> => {
  const signalled = await Promise.all(
    records.map(async (record) =>
      (await signalRun(record, force)) ? record : null,
    ),
  );
  const killed = signalled.filter(
    (record): record is MutationRunRecord => record !== null,
  );
  for (const record of killed) console.log(`Signalled ${record.id}.`);
  if (killed.length === 0) {
    console.error(`No running isolated mutation run matched ${target}.`);
    return 1;
  }
  return 0;
};

const killRuns = (
  target: string,
  force: boolean,
  root = projectRoot,
): Promise<number> =>
  withSelectedRuns(target, root, (records) =>
    signalMatchedRuns(records, force, target),
  );

const removeMatchedRuns = async (
  records: MutationRunRecord[],
  target: string,
): Promise<number> => {
  const { removable, skipped } = await cleanableRuns(records);
  const removeResults = await Promise.all(removable.map(removeRun));
  const removed = removeResults
    .filter(
      (result): result is Extract<RemoveRunResult, { removed: true }> =>
        result.removed,
    )
    .map(({ record }) => record);
  const failed = removeResults.filter(
    (result): result is Extract<RemoveRunResult, { removed: false }> =>
      !result.removed,
  );

  for (const record of removed) console.log(`Removed ${record.id}.`);
  for (const result of failed) reportRemoveFailure("", result);
  for (const record of skipped) {
    console.error(`Skipped active isolated mutation run ${record.id}.`);
  }
  if (failed.length > 0) return 1;
  if (removed.length === 0) {
    console.error(`No cleanable isolated mutation run matched ${target}.`);
    return 1;
  }
  return 0;
};

const cleanRuns = (target: string, root = projectRoot): Promise<number> =>
  withSelectedRuns(target, root, (records) =>
    removeMatchedRuns(records, target),
  );

export const runIsolatedMutationCommand: MutationCommandRunner = async (
  args,
  root = projectRoot,
) => {
  const command = parseIsolationCommand(args);
  if (command.kind === "invalid") {
    console.error(command.message);
    console.error(ISOLATION_USAGE);
    return 1;
  }
  if (command.kind === "help") {
    console.log(ISOLATION_USAGE);
    return 0;
  }
  if (command.kind === "list") return await listRuns(root);
  if (command.kind === "kill") {
    return await killRuns(command.target, command.force, root);
  }
  if (command.kind === "clean") return await cleanRuns(command.target, root);
  return await runMutationInSnapshot(command.args, root);
};
