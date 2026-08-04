/**
 * Side-effecting supervisor for isolated mutation runs.
 *
 * It copies the checkout, starts the normal mutation script inside that copy,
 * and manages list/kill/clean commands for `.mutation-runs/`.
 */

import { relative } from "@std/path";
import {
  INHERIT_STDIO,
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
  liveRunIdSet,
  removeFinishedRuns,
  removeInactiveRuns,
  removeWorkSnapshot,
  reportRemoveFailure,
  runIsOwned,
} from "./isolation-cleanup.ts";
import { withCopyBackLock, withRunClaim } from "./isolation-lock.ts";
import { readRunRecords, writeRunRecord } from "./isolation-records.ts";
import {
  copyMutationSnapshot,
  createRunId,
  formatRunList,
  ISOLATION_USAGE,
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_SUPERVISOR_PID_ENV,
  MUTATION_WORK_ROOT_ENV,
  type MutationRunRecord,
  markChildEnded,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  rewriteMutationArgs,
  runClaimPath,
  type SnapshotArgsFn,
  selectedRuns,
} from "./isolation-state.ts";
import {
  bringFilesBack,
  type CopyBackFile,
  readCopyBackFiles,
} from "./snapshot-copy-back.ts";

/** Runs a mutation command from its argv and returns a process exit code. */
type MutationCommandRunner = (args: string[], root?: string) => Promise<number>;

/** What a run does inside its copy of the checkout. */
export interface SnapshotRun {
  args: string[];
  /** Paths, relative to the checkout, to bring back when the run finishes. */
  copyBack?: string[];
  /** The script the child runs, relative to the checkout. */
  entryScript: string;
}

const MUTATION_ENTRY_SCRIPT = "scripts/mutation.ts";

const signalRun = async (
  record: MutationRunRecord,
  force: boolean,
): Promise<boolean> => {
  if (!(await runIsOwned(record)) || record.pid === undefined) {
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
    // The child keeps the run's claim fresh, and needs to know whether this
    // supervisor is still alive to release it when the child ends.
    [MUTATION_SUPERVISOR_PID_ENV]: String(Deno.pid),
    [MUTATION_WORK_ROOT_ENV]: snapshotRoot,
  });

const childArgs =
  (entryScript: string): SnapshotArgsFn =>
  (root, snapshotRoot, args) => [
    "run",
    "-A",
    entryScript,
    ...rewriteMutationArgs(root, snapshotRoot, args),
  ];

const forceStopChild = (
  child: Deno.ChildProcess | null,
  record: MutationRunRecord,
): never => {
  if (child) stopProcessNow(child);
  // Exiting here skips the claim's release, so take the claim down first.
  // It is this supervisor's own — held fresh since it was taken, and no
  // other code runs mid-removal — and without it the run reads as over at
  // once instead of after a whole stale window.
  Deno.removeSync(runClaimPath(record));
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

/**
 * Bring the run's kept files back, one run at a time across the checkout. The
 * question is asked again inside the lock: waiting for it is a moment long
 * enough to be interrupted, and an interrupted run keeps nothing.
 */
const keepFiles = (
  wasInterrupted: () => boolean,
  root: string,
  workRoot: string,
  copyBack: CopyBackFile[],
): Promise<number> =>
  withCopyBackLock(root, () =>
    wasInterrupted()
      ? Promise.resolve(0)
      : bringFilesBack(root, workRoot, copyBack),
  );

/**
 * Record the child's result, then bring back what the run means to keep. The
 * supervisor's claim on the run stays fresh throughout, so a clear-up
 * elsewhere can neither take the copy before its kept files are read nor take
 * the folder while the last record write lands in it.
 */
const finishChild = async (
  record: MutationRunRecord,
  wasInterrupted: () => boolean,
  code: number,
  root: string,
  copyBack: CopyBackFile[],
): Promise<{ exitCode: number; record: MutationRunRecord }> => {
  const failedToKeep =
    wasInterrupted() || copyBack.length === 0
      ? 0
      : await keepFiles(wasInterrupted, root, record.workRoot, copyBack);
  const interrupted = wasInterrupted();
  // A run that could not keep its files failed, whatever the child said.
  const exitCode = interrupted ? 130 : failedToKeep || code;
  const settled = settleRecord(record, interrupted, exitCode);
  await writeRunRecord(settled);
  return { exitCode, record: settled };
};

export const runInSnapshot = async (
  run: SnapshotRun,
  root = projectRoot,
): Promise<number> => {
  const { args } = run;
  const copyBack = await readCopyBackFiles(root, run.copyBack ?? []);
  await removeInactiveRuns(root);
  const id = createRunId();
  let record = newRunRecord(id, args, root);
  // Claimed before the record's first write and held until the snapshot is
  // gone, so there is no moment when a clear-up can see this run unowned.
  return await withRunClaim(record, async () => {
    await writeRunRecord(record);

    let child: Deno.ChildProcess | null = null;
    let interrupted = false;
    const stopChild = (): void => {
      if (interrupted) forceStopChild(child, record);
      interrupted = true;
      killChildQuietly(child);
    };
    onTerminationSignals(stopChild);

    let exitCode = 1;
    try {
      console.log(`Creating isolated mutation run ${id}`);
      console.log(`Snapshot: ${relative(root, record.workRoot)}`);
      await copyMutationSnapshot(root, record.workRoot);
      if (interrupted) {
        record = markInterrupted(record);
        await writeRunRecord(record);
        exitCode = 130;
      } else {
        const spawned = new Deno.Command(Deno.execPath(), {
          args: childArgs(run.entryScript)(root, record.workRoot, args),
          cwd: record.workRoot,
          env: childEnv(id, record.root, record.workRoot),
          ...INHERIT_STDIO,
        }).spawn();
        child = spawned;
        record = markRunning(record, spawned.pid);
        await writeRunRecord(record);
        console.log(`Mutation child pid ${spawned.pid}`);

        const status = await spawned.status;
        record = markChildEnded(record);
        await writeRunRecord(record);
        const finished = await finishChild(
          record,
          () => interrupted,
          status.code,
          root,
          copyBack,
        );
        record = finished.record;
        exitCode = finished.exitCode;
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
    await removeWorkSnapshot(record);
    return exitCode;
  });
};

export const runMutationInSnapshot: MutationCommandRunner = (
  args,
  root = projectRoot,
) => runInSnapshot({ args, entryScript: MUTATION_ENTRY_SCRIPT }, root);

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
  const { failed, removed, skipped } = await removeFinishedRuns(records);

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
