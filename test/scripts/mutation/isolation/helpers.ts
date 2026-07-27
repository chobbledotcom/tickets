import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { runMutationInSnapshot } from "#scripts/mutation/isolation.ts";
import {
  type MutationRunRecord,
  readRunRecords,
  writeRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import { captureConsole } from "#test/scripts/mutation/isolation-helpers.ts";

export const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export const SNAPSHOT_FAILED = "snapshot failed";

export const sendFirstSignalImmediately = () => {
  let sent = false;
  return stub(Deno, "addSignalListener", ((_signal, listener) => {
    if (!sent) {
      sent = true;
      listener();
    }
  }) as typeof Deno.addSignalListener);
};

export const failSnapshotRead = (reason: unknown) =>
  stub(Deno, "readDir", (() => {
    throw reason;
  }) as typeof Deno.readDir);

export const failTextFileWrites = (
  shouldFail: (writeNumber: number) => boolean,
) => {
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

export const failRunningStatusWrite = () => {
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
  extraFailure: (() => Disposable) | null = null,
): Promise<Awaited<ReturnType<typeof captureConsole>>> => {
  using _readDir = failSnapshotRead(SNAPSHOT_FAILED);
  if (extraFailure) {
    using _extraFailure = extraFailure();
    return await captureSimpleSnapshotMutation(root);
  }
  return await captureSimpleSnapshotMutation(root);
};

export const waitForRunningRecord = async (
  root: string,
): Promise<MutationRunRecord> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = (await readRunRecords(root)).find(
      (candidate) => candidate.status === "running",
    );
    if (record) return record;
    await wait(10);
  }
  throw new Error("Mutation child did not start.");
};

export const writeRecords = async (
  records: MutationRunRecord[],
): Promise<void> => {
  await Promise.all(records.map(writeRunRecord));
};

/** Wait until the run has written its record, so the check is not a race. */
export const waitForRunRecord = async (root: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await readRunRecords(root)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The run never wrote its record while waiting for the lock.");
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
type DenoCommandShim = { Command: (...args: unknown[]) => unknown };

export const denoCommand = Deno as unknown as DenoCommandShim;
export const childCommand = (child: Deno.ChildProcess) =>
  function fakeCommand(): { spawn: () => Deno.ChildProcess } {
    return {
      spawn: () => child,
    };
  };

export const controlledChild = (
  pid: number,
  onKill: (
    signal: Deno.Signal | undefined,
    finish: (status: Deno.CommandStatus) => void,
  ) => void,
) => {
  let resolveStatus: (status: Deno.CommandStatus) => void = () => {};
  const status = new Promise<Deno.CommandStatus>((resolve) => {
    resolveStatus = resolve;
  });
  const child = {
    kill: (signal?: Deno.Signal) => onKill(signal, resolveStatus),
    pid,
    ref: () => {},
    status,
  } as unknown as Deno.ChildProcess;

  return { child, finish: resolveStatus };
};
