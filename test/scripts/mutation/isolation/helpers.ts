import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { runMutationInSnapshot } from "#scripts/mutation/isolation.ts";
import {
  readRunRecords,
  writeRunRecord,
} from "#scripts/mutation/isolation-records.ts";
import {
  MUTATION_RUNS_DIR,
  MUTATION_WORK_DIR,
  type MutationRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import { captureConsole } from "#test/scripts/mutation/isolation-helpers.ts";

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export const SNAPSHOT_FAILED = "snapshot failed";

export const sendFirstSignalImmediately = (): Disposable => {
  let sent = false;
  return stub(Deno, "addSignalListener", ((_signal, listener) => {
    if (!sent) {
      sent = true;
      listener();
    }
  }) as typeof Deno.addSignalListener);
};

/**
 * Fail the reads that walk the checkout, so copying a snapshot fails. Reads of
 * the runs folder itself still work, since finding runs is not the copy.
 */
export const failSnapshotRead = (
  reason: unknown,
  onFail: () => void = () => {},
): Disposable => {
  const readDir = Deno.readDir;
  return stub(Deno, "readDir", ((path: string | URL) => {
    if (`${path}`.includes(MUTATION_RUNS_DIR)) return readDir(path);
    onFail();
    throw reason;
  }) as typeof Deno.readDir);
};

export const failTextFileWrites = (
  shouldFail: (
    writeNumber: number,
    data: string | ReadableStream<string>,
  ) => boolean,
): Disposable => {
  const writeTextFile = Deno.writeTextFile;
  let writes = 0;
  return stub(Deno, "writeTextFile", ((
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: Deno.WriteFileOptions,
  ) => {
    writes += 1;
    if (shouldFail(writes, data)) throw new Error("record write failed");
    return writeTextFile(path, data, options);
  }) as typeof Deno.writeTextFile);
};

/** Let every write through except the one marking the run as running. */
export const failRunningStatusWrite = (): Disposable =>
  failTextFileWrites(
    (_writes, data) => typeof data === "string" && data.includes('"running"'),
  );

/** Refuse to remove the run's snapshot, standing in for a busy work folder. */
export const failWorkRemoval = (): Disposable => {
  const remove = Deno.remove;
  return stub(Deno, "remove", ((
    path: string | URL,
    options?: Deno.RemoveOptions,
  ) => {
    if (`${path}`.endsWith(`/${MUTATION_WORK_DIR}`)) {
      throw new Error("work is busy");
    }
    return remove(path, options);
  }) as typeof Deno.remove);
};

export const capturePlainSnapshotFailure = async (
  root: string,
): Promise<Awaited<ReturnType<typeof captureConsole>>> => {
  using _readDir = failSnapshotRead(SNAPSHOT_FAILED);
  return await captureSimpleSnapshotMutation(root);
};

/** Keep reading the run records until one of them answers, or give up. */
export const waitForRecord = async <Found>(
  root: string,
  look: (records: MutationRunRecord[]) => Found | undefined,
  giveUpMessage: string,
  attempts = 200,
): Promise<Found> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = look(await readRunRecords(root));
    if (found !== undefined) return found;
    await wait(10);
  }
  throw new Error(giveUpMessage);
};

export const waitForRunningRecord = (
  root: string,
): Promise<MutationRunRecord> =>
  waitForRecord(
    root,
    (records) => records.find((record) => record.status === "running"),
    "Mutation child did not start.",
  );

export const writeRecords = async (
  records: MutationRunRecord[],
): Promise<void> => {
  await Promise.all(records.map(writeRunRecord));
};

export const readOnlyRunRecord = async (
  root: string,
): Promise<MutationRunRecord> => {
  const records = await readRunRecords(root);
  expect(records).toHaveLength(1);
  return records[0]!;
};

const runSimpleSnapshotMutation = (root: string): Promise<number> =>
  runMutationInSnapshot(["src/a.ts", "test/a.test.ts"], root);

export const captureSimpleSnapshotMutation = (
  root: string,
): ReturnType<typeof captureConsole> =>
  captureConsole(() => runSimpleSnapshotMutation(root));

export const withCapturedStopChild = async (
  run: (getStopChild: () => (() => void) | undefined) => Promise<void>,
): Promise<void> => {
  let stopChild: (() => void) | undefined;
  using _addSignal = stub(Deno, "addSignalListener", ((_signal, listener) => {
    stopChild = listener;
  }) as typeof Deno.addSignalListener);
  using _removeSignal = stub(
    Deno,
    "removeSignalListener",
    (() => {}) as typeof Deno.removeSignalListener,
  );

  await run(() => stopChild);
};

export type KillCall = { pid: number; signal: Deno.Signal | undefined };

/** Note every signal sent instead of sending it, so a test can read them. */
export const recordKillCalls = (calls: KillCall[]): Disposable =>
  stub(Deno, "kill", ((pid: number, signal?: Deno.Signal) => {
    calls.push({ pid, signal });
  }) as typeof Deno.kill);

/** `Deno.Command` is a class, so stubbing it needs a looser view of `Deno`. */
type DenoCommandShim = { Command: (...args: unknown[]) => unknown };
const denoCommand = Deno as unknown as DenoCommandShim;

/**
 * Hand out the given child instead of starting a real one, recording the
 * options each start was asked for.
 */
export const stubCommand = (
  child: Deno.ChildProcess,
  starts: Deno.CommandOptions[] = [],
  onStart: () => void = () => {},
): Disposable =>
  stub(denoCommand, "Command", (...args: unknown[]) => {
    const [, options] = args as [unknown, Deno.CommandOptions];
    starts.push(options);
    onStart();
    return { spawn: () => child };
  });

/** A child that has already finished with the given exit code. */
export const finishedChild = (pid: number, code = 0): Deno.ChildProcess =>
  ({
    pid,
    status: Promise.resolve({ code, signal: null, success: code === 0 }),
  }) as unknown as Deno.ChildProcess;

export const controlledChild = (
  pid: number,
  onKill: (
    signal: Deno.Signal | undefined,
    finish: (status: Deno.CommandStatus) => void,
  ) => void,
): {
  child: Deno.ChildProcess;
  finish: (status: Deno.CommandStatus) => void;
} => {
  const { promise: status, resolve: resolveStatus } =
    Promise.withResolvers<Deno.CommandStatus>();
  const child = {
    kill: (signal?: Deno.Signal) => onKill(signal, resolveStatus),
    pid,
    ref: () => {},
    status,
  } as unknown as Deno.ChildProcess;

  return { child, finish: resolveStatus };
};
