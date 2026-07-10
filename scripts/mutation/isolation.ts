/**
 * Side-effecting supervisor for isolated mutation runs.
 *
 * It copies the checkout, starts the normal mutation script inside that copy,
 * and manages list/kill/clean commands for `.mutation-runs/`.
 */

import { relative } from "@std/path";
import { processExists, stopProcess, stopProcessNow } from "../process.ts";
import { projectRoot } from "../project-root.ts";
import {
  copyMutationSnapshot,
  createRunId,
  formatRunList,
  ISOLATION_USAGE,
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
  runLockIsHeld,
  runStartedRecently,
  selectedRuns,
  withMutationRunLock,
  writeRunRecord,
} from "./isolation-state.ts";

const processBelongsToRun = async (
  record: MutationRunRecord,
): Promise<boolean> => {
  if (record.status !== "running" || record.pid === undefined) return false;
  if (!processExists(record.pid)) return false;
  return await runLockIsHeld(record);
};

const copyingRunStillActive = async (
  record: MutationRunRecord,
): Promise<boolean> =>
  record.status === "copying" && (await runLockIsHeld(record));

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

const removeRun = async (
  record: MutationRunRecord,
): Promise<RemoveRunResult> => {
  try {
    await Deno.remove(record.root, { recursive: true });
    return { record, removed: true };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { record, removed: true };
    }
    return { error, record, removed: false };
  }
};

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
): Record<string, string> => ({
  ...Deno.env.toObject(),
  [MUTATION_SNAPSHOT_CHILD_ENV]: "1",
  [MUTATION_RUN_ID_ENV]: id,
  [MUTATION_RUN_ROOT_ENV]: runRootPath,
  [MUTATION_WORK_ROOT_ENV]: snapshotRoot,
});

const childArgs = (
  root: string,
  snapshotRoot: string,
  args: string[],
): string[] => [
  "run",
  "-A",
  "scripts/mutation.ts",
  ...rewriteMutationArgs(root, snapshotRoot, args),
];

export const runMutationInSnapshot = async (
  args: string[],
  root = projectRoot,
): Promise<number> => {
  const id = createRunId();
  let record = newRunRecord(id, args, root);
  await writeRunRecord(record);

  let child: Deno.ChildProcess | null = null;
  let interrupted = false;
  const stopChild = (): void => {
    if (interrupted) {
      if (child) stopProcessNow(child);
      Deno.exit(130);
    }
    interrupted = true;
    if (child) {
      try {
        child.kill();
      } catch {
        // It may already have exited.
      }
    }
  };
  const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    try {
      Deno.addSignalListener(signal, stopChild);
    } catch {
      // Signal handling is platform-dependent; the child still owns cleanup.
    }
  }

  let exitCode = 1;
  try {
    console.log(`Creating isolated mutation run ${id}`);
    console.log(`Snapshot: ${relative(root, record.workRoot)}`);
    child = await withMutationRunLock(record.root, async () => {
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
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      }).spawn();
      child = spawned;
      record = markRunning(record, spawned.pid);
      await writeRunRecord(record);
      console.log(`Mutation child pid ${spawned.pid}`);
      return spawned;
    });

    if (child !== null) {
      const status = await child.status;
      record = interrupted
        ? markInterrupted(record)
        : markFinished(record, status.code);
      await writeRunRecord(record);
      exitCode = interrupted ? 130 : status.code;
    }
  } catch (error) {
    if (child !== null) await stopProcess(child, 250);
    exitCode = interrupted ? 130 : 1;
    record = interrupted
      ? markInterrupted(record)
      : markFinished(record, exitCode);
    try {
      await writeRunRecord(record);
    } catch {
      // A failed write should not mask the original error.
    }
    console.error(error instanceof Error ? error.message : String(error));
  }
  for (const signal of signals) {
    try {
      Deno.removeSignalListener(signal, stopChild);
    } catch {
      // Matches the add above.
    }
  }
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

const killRuns = async (
  target: string,
  force: boolean,
  root = projectRoot,
): Promise<number> => {
  const records = selectedRuns(await readRunRecords(root), target);
  if (records.length === 0) {
    console.error(`No isolated mutation run matched ${target}.`);
    return 1;
  }
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

const cleanRuns = async (
  target: string,
  root = projectRoot,
): Promise<number> => {
  const records = selectedRuns(await readRunRecords(root), target);
  if (records.length === 0) {
    console.error(`No isolated mutation run matched ${target}.`);
    return 1;
  }
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
  for (const { error, record } of failed) {
    console.error(
      `Failed to remove ${record.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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

export const runIsolatedMutationCommand = async (
  args: string[],
  root = projectRoot,
): Promise<number> => {
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
