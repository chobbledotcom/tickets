import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { pathExists } from "#test-utils/files.ts";
import { runMutationInSnapshot } from "../../scripts/mutation/isolation.ts";
import {
  type MutationRunRecord,
  readRunRecords,
} from "../../scripts/mutation/isolation-state.ts";
import {
  captureConsole,
  captureMutationCommand,
  denoCommand,
  withTempDir,
  writeFakeMutationScript,
} from "./mutation-isolation-helpers.ts";

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const SNAPSHOT_FAILED = "snapshot failed";

const sendFirstSignalImmediately = () => {
  let sent = false;
  return stub(Deno, "addSignalListener", ((_signal, listener) => {
    if (!sent) {
      sent = true;
      listener();
    }
  }) as typeof Deno.addSignalListener);
};

const failSnapshotRead = (reason: unknown) =>
  stub(Deno, "readDir", (() => {
    throw reason;
  }) as typeof Deno.readDir);

const failTextFileWrites = (shouldFail: (writeNumber: number) => boolean) => {
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

const failRunningStatusWrite = () => {
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

const capturePlainSnapshotFailure = async (
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

const waitForRunningRecord = async (
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

const readOnlyRunRecord = async (root: string): Promise<MutationRunRecord> => {
  const records = await readRunRecords(root);
  expect(records).toHaveLength(1);
  return records[0]!;
};

const runSimpleSnapshotMutation = (root: string): Promise<number> =>
  runMutationInSnapshot(["src/a.ts", "test/a.test.ts"], root);

const captureSimpleSnapshotMutation = (
  root: string,
): ReturnType<typeof captureConsole> =>
  captureConsole(() => runSimpleSnapshotMutation(root));

const withCapturedStopChild = async (
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

const childCommand = (child: Deno.ChildProcess) =>
  function fakeCommand(): { spawn: () => Deno.ChildProcess } {
    return {
      spawn: () => child,
    };
  };

const controlledChild = (
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

describe("mutation isolation supervisor commands", () => {
  test("runs mutation in a copied snapshot and records the exit code", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(7);\n");

      const run = await captureMutationCommand(
        ["src/a.ts", join(root, "test/a.test.ts")],
        root,
      );
      const record = await readOnlyRunRecord(root);

      expect(run.result).toBe(7);
      expect(run.errors).toEqual([]);
      expect(run.logs[0]?.startsWith("Creating isolated mutation run ")).toBe(
        true,
      );
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(7);
      expect(record.args).toEqual(["src/a.ts", join(root, "test/a.test.ts")]);
      expect(typeof record.pid).toBe("number");
      expect(
        await pathExists(join(record.workRoot, "scripts", "mutation.ts")),
      ).toBe(true);
    });
  });

  test("marks the run interrupted when a signal arrives before the child starts", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      using _addSignal = sendFirstSignalImmediately();

      const run = await captureSimpleSnapshotMutation(root);
      const record = await readOnlyRunRecord(root);

      expect(run.result).toBe(130);
      expect(record.status).toBe("interrupted");
      expect(record.exitCode).toBe(130);
    });
  });

  test("records an interrupted run when snapshot copying fails after a signal", async () => {
    await withTempDir(async (root) => {
      await Deno.mkdir(join(root, "src"));
      await Deno.symlink("missing.ts", join(root, "src", "missing.ts"));

      using _addSignal = sendFirstSignalImmediately();

      const run = await captureConsole(() =>
        runMutationInSnapshot(["src/missing.ts", "test/missing.test.ts"], root),
      );
      const record = await readOnlyRunRecord(root);

      expect(run.result).toBe(130);
      expect(run.errors).toHaveLength(1);
      expect(record.status).toBe("interrupted");
      expect(record.exitCode).toBe(130);
    });
  });

  test("records a failed run when snapshot copying throws a plain value", async () => {
    await withTempDir(async (root) => {
      const run = await capturePlainSnapshotFailure(root);
      const record = await readOnlyRunRecord(root);

      expect(run).toMatchObject({ errors: [SNAPSHOT_FAILED], result: 1 });
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
    });
  });

  test("keeps the original failure when the failed record cannot be rewritten", async () => {
    await withTempDir(async (root) => {
      let copyFailed = false;
      const failSnapshotReadAfterMarkingCopyFailed = (reason: unknown) =>
        stub(Deno, "readDir", (() => {
          copyFailed = true;
          throw reason;
        }) as typeof Deno.readDir);
      const run = await (async () => {
        using _readDir =
          failSnapshotReadAfterMarkingCopyFailed(SNAPSHOT_FAILED);
        using _writeTextFile = failTextFileWrites(() => copyFailed);

        return await captureSimpleSnapshotMutation(root);
      })();
      const record = await readOnlyRunRecord(root);

      expect(run).toMatchObject({ errors: [SNAPSHOT_FAILED], result: 1 });
      expect(record.status).toBe("copying");
    });
  });

  test("stops the child when recording its pid fails", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      const killCalls: (Deno.Signal | undefined)[] = [];
      const process = controlledChild(42_424, (signal, finish) => {
        killCalls.push(signal);
        finish({ code: 143, signal: "SIGTERM", success: false });
      });
      using _command = stub(
        denoCommand,
        "Command",
        childCommand(process.child),
      );

      using _writeTextFile = failRunningStatusWrite();

      const run = await captureSimpleSnapshotMutation(root);
      const record = await readOnlyRunRecord(root);

      expect(run.result).toBe(1);
      expect(run.errors).toEqual(["record write failed"]);
      expect(killCalls).toEqual([undefined]);
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
    });
  });

  test("records interrupted when a running child exits after a signal", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "await new Promise(() => {});\n");

      const originalKill = Deno.kill;
      await withCapturedStopChild(async (getStopChild) => {
        const run = captureSimpleSnapshotMutation(root);
        const record = await waitForRunningRecord(root);

        getStopChild()?.();
        originalKill(record.pid!, "SIGKILL");
        await run;

        const finished = await readOnlyRunRecord(root);
        expect(finished.status).toBe("interrupted");
        expect(finished.exitCode).toBe(130);
      });
    });
  });

  test("records interrupted when the signalled child already stopped", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      let killCalls = 0;
      const process = controlledChild(42_425, () => {
        killCalls += 1;
        throw new Error("already stopped");
      });
      using _command = stub(
        denoCommand,
        "Command",
        childCommand(process.child),
      );

      await withCapturedStopChild(async (getStopChild) => {
        const run = captureSimpleSnapshotMutation(root);
        await waitForRunningRecord(root);

        getStopChild()?.();
        process.finish({ code: 0, signal: null, success: true });

        expect((await run).result).toBe(130);
        expect(killCalls).toBe(1);
        const finished = await readOnlyRunRecord(root);
        expect(finished.status).toBe("interrupted");
        expect(finished.exitCode).toBe(130);
      });
    });
  });

  test("escalates repeated interrupts", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "await new Promise(() => {});\n");

      const originalKill = Deno.kill;
      using _exit = stub(Deno, "exit", ((code) => {
        throw new Error(`exit ${code}`);
      }) as typeof Deno.exit);
      await withCapturedStopChild(async (getStopChild) => {
        const run = captureSimpleSnapshotMutation(root);
        const record = await waitForRunningRecord(root);

        expect(getStopChild()).toBeDefined();
        getStopChild()?.();
        expect(() => getStopChild()?.()).toThrow("exit 130");

        try {
          originalKill(record.pid!, "SIGKILL");
        } catch {
          // The supervisor may already have stopped it.
        }
        expect((await run).result).not.toBe(0);
      });
    });
  });

  test("records failure when starting the snapshot child throws", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      using _addSignal = stub(Deno, "addSignalListener", (() => {
        throw new Error("signals unavailable");
      }) as typeof Deno.addSignalListener);
      using _removeSignal = stub(Deno, "removeSignalListener", (() => {
        throw new Error("not registered");
      }) as typeof Deno.removeSignalListener);
      using _execPath = stub(Deno, "execPath", (() =>
        join(root, "missing-deno")) as typeof Deno.execPath);

      const run = await captureSimpleSnapshotMutation(root);
      const record = await readOnlyRunRecord(root);

      expect(run.result).toBe(1);
      expect(run.errors).toHaveLength(1);
      expect(run.errors[0]).toContain("missing-deno");
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
    });
  });
});
