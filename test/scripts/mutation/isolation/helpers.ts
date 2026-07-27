import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { runMutationInSnapshot } from "#scripts/mutation/isolation.ts";
import {
  MUTATION_RECORD_FILE,
  MUTATION_RUNS_DIR,
  type MutationRunRecord,
  readRunRecords,
  writeRunRecord,
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

export const failSnapshotRead = (reason: unknown): Disposable =>
  stub(Deno, "readDir", (() => {
    throw reason;
  }) as typeof Deno.readDir);

export const failTextFileWrites = (
  shouldFail: (writeNumber: number) => boolean,
): Disposable => {
  const writeTextFile = Deno.writeTextFile;
  let writes = 0;
  return stub(Deno, "writeTextFile", ((
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: Deno.WriteFileOptions,
  ) => {
    writes += 1;
    if (shouldFail(writes)) throw new Error("record write failed");
    return writeTextFile(path, data, options);
  }) as typeof Deno.writeTextFile);
};

export const failRunningStatusWrite = (): Disposable => {
  const original = Deno.writeTextFile;
  return stub(Deno, "writeTextFile", ((
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: Deno.WriteFileOptions,
  ) => {
    if (typeof data === "string" && data.includes('"running"')) {
      throw new Error("record write failed");
    }
    return original(path, data, options);
  }) as typeof Deno.writeTextFile);
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

export const runSimpleSnapshotMutation = (root: string): Promise<number> =>
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

/**
 * Run a snapshot mutation while a `--clean` sweeps its record away in the gap
 * before the lock, and report whether the record was there at each point.
 */
export const recordAroundClean = async (
  root: string,
): Promise<{ beforeLock: boolean; atChildStart: boolean }> => {
  const realMkdir = Deno.mkdir;
  let runDir = "";
  // The run folder is made twice: once to write the record, then again by the
  // lock. The second time is the moment the run starts queueing.
  const madeRunFolder = new Set<string>();
  const result = { atChildStart: false, beforeLock: false };
  const recordPath = () => join(runDir, MUTATION_RECORD_FILE);

  using _mkdir = stub(Deno, "mkdir", (async (
    path: string | URL,
    options?: Deno.MkdirOptions,
  ) => {
    await realMkdir(path, options);
    if (runDir || !`${path}`.includes(`${MUTATION_RUNS_DIR}/mutation-`)) return;
    if (!madeRunFolder.has(`${path}`)) {
      madeRunFolder.add(`${path}`);
      return;
    }
    runDir = `${path}`;
    result.beforeLock = existsSync(recordPath());
    // Stand in for a `--clean` sweeping away a run it sees as unlocked.
    await Deno.remove(recordPath());
  }) as typeof Deno.mkdir);
  using _command = stubCommand(finishedChild(42_427), [], () => {
    result.atChildStart = existsSync(recordPath());
  });

  await captureSimpleSnapshotMutation(root);
  return result;
};

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
