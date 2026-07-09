/**
 * Side-effecting supervisor for isolated mutation runs.
 *
 * It copies the checkout, starts the normal mutation script inside that copy,
 * and manages list/kill/clean commands for `.mutation-runs/`.
 */

import { relative } from "@std/path";
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
  selectedRuns,
  writeRunRecord,
} from "./isolation-state.ts";

const processExists = async (pid: number): Promise<boolean> => {
  const result = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
    stdout: "null",
  }).output();
  return result.success;
};

const processBelongsToRun = async (
  record: MutationRunRecord,
): Promise<boolean> => {
  if (record.status !== "running" || record.pid === undefined) return false;
  if (!(await processExists(record.pid))) return false;
  return await runLockIsHeld(record);
};

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

const removeRun = async (record: MutationRunRecord): Promise<void> => {
  await Deno.remove(record.root, { recursive: true }).catch(() => {});
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
        record.status === "copying" || (await processBelongsToRun(record)),
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
      if (child) Deno.kill(child.pid, "SIGKILL");
      Deno.exit(130);
    }
    interrupted = true;
    if (child) Deno.kill(child.pid, "SIGTERM");
  };
  const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    try {
      Deno.addSignalListener(signal, stopChild);
    } catch {
      // Signal handling is platform-dependent; the child still owns cleanup.
    }
  }

  let exitCode: number;
  try {
    console.log(`Creating isolated mutation run ${id}`);
    console.log(`Snapshot: ${relative(root, record.workRoot)}`);
    await copyMutationSnapshot(root, record.workRoot);
    if (interrupted) {
      record = markInterrupted(record);
      await writeRunRecord(record);
      exitCode = 130;
    } else {
      child = new Deno.Command(Deno.execPath(), {
        args: childArgs(root, record.workRoot, args),
        cwd: record.workRoot,
        env: childEnv(id, record.root, record.workRoot),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      }).spawn();
      record = markRunning(record, child.pid);
      await writeRunRecord(record);
      console.log(`Mutation child pid ${child.pid}`);

      const status = await child.status;
      record = markFinished(record, status.code);
      await writeRunRecord(record);
      exitCode = status.code;
    }
  } catch (error) {
    exitCode = interrupted ? 130 : 1;
    record = markFinished(record, exitCode);
    await writeRunRecord(record).catch(() => {});
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
  await Promise.all(removable.map(removeRun));
  for (const record of removable) console.log(`Removed ${record.id}.`);
  for (const record of skipped) {
    console.error(`Skipped active isolated mutation run ${record.id}.`);
  }
  if (removable.length === 0) {
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
