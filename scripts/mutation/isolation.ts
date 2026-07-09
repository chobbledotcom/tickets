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
  MUTATION_SNAPSHOT_CHILD_ENV,
  type MutationRunRecord,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  readRunRecords,
  rewriteMutationArgs,
  selectedRuns,
  writeRunRecord,
} from "./isolation-state.ts";

export { MUTATION_SNAPSHOT_CHILD_ENV } from "./isolation-state.ts";

const processExists = async (pid: number): Promise<boolean> => {
  const result = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
    stdout: "null",
  }).output();
  return result.success;
};

const livePidSet = async (
  records: MutationRunRecord[],
): Promise<Set<number>> => {
  const live = await Promise.all(
    records.map(async (record) => {
      if (record.pid === undefined) return null;
      return (await processExists(record.pid)) ? record.pid : null;
    }),
  );
  return new Set(live.filter((pid): pid is number => pid !== null));
};

const removeRun = async (record: MutationRunRecord): Promise<void> => {
  await Deno.remove(record.root, { recursive: true }).catch(() => {});
};

const signalRun = (record: MutationRunRecord, force: boolean): boolean => {
  if (record.status !== "running" || record.pid === undefined) return false;
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
  TICKETS_MUTATION_RUN_ID: id,
  TICKETS_MUTATION_RUN_ROOT: runRootPath,
  TICKETS_MUTATION_WORK_ROOT: snapshotRoot,
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

  try {
    console.log(`Creating isolated mutation run ${id}`);
    console.log(`Snapshot: ${relative(root, record.workRoot)}`);
    await copyMutationSnapshot(root, record.workRoot);
    if (interrupted) {
      record = markInterrupted(record);
      await writeRunRecord(record);
      return 130;
    }

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
    return status.code;
  } catch (error) {
    record = markFinished(record, interrupted ? 130 : 1);
    await writeRunRecord(record).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    return interrupted ? 130 : 1;
  } finally {
    for (const signal of signals) {
      try {
        Deno.removeSignalListener(signal, stopChild);
      } catch {
        // Matches the add above.
      }
    }
  }
};

const listRuns = async (root = projectRoot): Promise<number> => {
  const records = await readRunRecords(root);
  const livePids = await livePidSet(records);
  for (const line of formatRunList(records, livePids, root)) console.log(line);
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
  const killed = records.filter((record) => signalRun(record, force));
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
  await Promise.all(records.map(removeRun));
  for (const record of records) console.log(`Removed ${record.id}.`);
  return 0;
};

export const runIsolatedMutationCommand = async (
  args: string[],
  root = projectRoot,
): Promise<number> => {
  const command = parseIsolationCommand(args);
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
