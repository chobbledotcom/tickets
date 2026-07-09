import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { pathExists } from "#test-utils/files.ts";
import { runMutationInSnapshot } from "../../scripts/mutation/isolation.ts";
import {
  ISOLATION_USAGE,
  type MutationRunRecord,
  markFinished,
  markRunning,
  newRunRecord,
  readRunRecords,
  withMutationRunLock,
  writeRunRecord,
} from "../../scripts/mutation/isolation-state.ts";
import {
  captureConsole,
  captureMutationCommand,
  runQuietMutationCommand,
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

const failSecondTextFileWrite = () => {
  const writeTextFile = Deno.writeTextFile;
  let writes = 0;
  return stub(Deno, "writeTextFile", ((
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: Deno.WriteFileOptions,
  ) => {
    writes += 1;
    if (writes > 1) throw new Error("record write failed");
    return writeTextFile(path, data, options);
  }) as typeof Deno.writeTextFile);
};

const capturePlainSnapshotFailure = async (
  root: string,
  extraFailure: (() => Disposable) | null = null,
): Promise<Awaited<ReturnType<typeof captureConsole>>> => {
  using _readDir = failSnapshotRead(SNAPSHOT_FAILED);
  const captureRun = () =>
    captureConsole(() =>
      runMutationInSnapshot(["src/a.ts", "test/a.test.ts"], root),
    );
  if (extraFailure) {
    using _extraFailure = extraFailure();
    return await captureRun();
  }
  return await captureRun();
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

const writeRecords = async (records: MutationRunRecord[]): Promise<void> => {
  await Promise.all(records.map(writeRunRecord));
};

const readOnlyRunRecord = async (root: string): Promise<MutationRunRecord> => {
  const records = await readRunRecords(root);
  expect(records).toHaveLength(1);
  return records[0]!;
};

type KillCall = { pid: number; signal: Deno.Signal | undefined };

describe("mutation isolation supervisor commands", () => {
  test("runs invalid, help, and empty list commands", async () => {
    await withTempDir(async (root) => {
      const invalid = await captureMutationCommand([], root);
      expect(invalid.result).toBe(1);
      expect(invalid.errors[0]).toBe(
        "Mutation source and test globs are required.",
      );
      expect(invalid.errors[1]).toBe(ISOLATION_USAGE);

      const help = await captureMutationCommand(["--help"], root);
      expect(help).toEqual({ errors: [], logs: [ISOLATION_USAGE], result: 0 });

      const list = await captureMutationCommand(["--list"], root);
      expect(list).toEqual({
        errors: [],
        logs: ["No isolated mutation runs."],
        result: 0,
      });
    });
  });

  test("lists running runs only when their pid and lock are live", async () => {
    await withTempDir(async (root) => {
      const unlocked = markRunning(
        newRunRecord("mutation-unlocked", [], root, "2026-07-09T12:04:00.000Z"),
        Deno.pid,
      );
      const live = markRunning(
        newRunRecord(
          "mutation-live",
          ["src/live.ts"],
          root,
          "2026-07-09T12:03:00.000Z",
        ),
        Deno.pid,
      );
      const stale = markRunning(
        newRunRecord("mutation-stale", [], root, "2026-07-09T12:02:00.000Z"),
        99_999_999,
      );
      const copying = newRunRecord(
        "mutation-copying",
        [],
        root,
        "2026-07-09T12:01:00.000Z",
      );
      await writeRecords([unlocked, live, stale, copying]);

      await withMutationRunLock(live.root, async () => {
        const list = await captureMutationCommand(["list"], root);

        expect(list).toEqual({
          errors: [],
          logs: [
            `mutation-unlocked stale pid=${Deno.pid} exit=- work=.mutation-runs/mutation-unlocked/work`,
            `mutation-live running pid=${Deno.pid} exit=- work=.mutation-runs/mutation-live/work args=src/live.ts`,
            "mutation-stale stale pid=99999999 exit=- work=.mutation-runs/mutation-stale/work",
            "mutation-copying copying pid=- exit=- work=.mutation-runs/mutation-copying/work",
          ],
          result: 0,
        });
      });
    });
  });

  test("signals live runs and reports missing or stale targets", async () => {
    await withTempDir(async (root) => {
      const live = markRunning(
        newRunRecord("mutation-live", [], root),
        Deno.pid,
      );
      const noPid = {
        ...newRunRecord("mutation-nopid", [], root),
        status: "running" as const,
      };
      const passed = markFinished(newRunRecord("mutation-passed", [], root), 0);
      await writeRecords([live, noPid, passed]);

      const calls: KillCall[] = [];
      using _kill = stub(Deno, "kill", ((pid, signal) => {
        calls.push({ pid, signal });
      }) as typeof Deno.kill);

      await withMutationRunLock(live.root, async () => {
        expect(
          await runQuietMutationCommand(["--kill", "mutation-live"], root),
        ).toBe(0);
        expect(
          await runQuietMutationCommand(
            ["kill", "mutation-live", "--force"],
            root,
          ),
        ).toBe(0);
      });

      expect(calls).toEqual([
        { pid: Deno.pid, signal: "SIGTERM" },
        { pid: Deno.pid, signal: "SIGKILL" },
      ]);
      expect(await runQuietMutationCommand(["--kill", "missing"], root)).toBe(
        1,
      );
      expect(
        await runQuietMutationCommand(["--kill", "mutation-passed"], root),
      ).toBe(1);
      expect(
        await runQuietMutationCommand(["--kill", "mutation-nopid"], root),
      ).toBe(1);
    });
  });

  test("reports live runs that cannot be signalled", async () => {
    await withTempDir(async (root) => {
      const live = markRunning(
        newRunRecord("mutation-live", [], root),
        Deno.pid,
      );
      await writeRunRecord(live);

      using _kill = stub(Deno, "kill", (() => {
        throw new Error("cannot signal");
      }) as typeof Deno.kill);

      await withMutationRunLock(live.root, async () => {
        expect(
          await runQuietMutationCommand(["--kill", "mutation-live"], root),
        ).toBe(1);
      });
    });
  });

  test("reports missing clean targets", async () => {
    await withTempDir(async (root) => {
      const clean = await captureMutationCommand(["--clean", "missing"], root);

      expect(clean).toEqual({
        errors: ["No isolated mutation run matched missing."],
        logs: [],
        result: 1,
      });
    });
  });

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

      const run = await captureConsole(() =>
        runMutationInSnapshot(["src/a.ts", "test/a.test.ts"], root),
      );
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
      const run = await capturePlainSnapshotFailure(
        root,
        failSecondTextFileWrite,
      );
      const record = await readOnlyRunRecord(root);

      expect(run).toMatchObject({ errors: [SNAPSHOT_FAILED], result: 1 });
      expect(record.status).toBe("copying");
    });
  });

  test("escalates repeated interrupts", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "await new Promise(() => {});\n");

      const originalKill = Deno.kill;
      let stopChild: (() => void) | undefined;
      const killCalls: KillCall[] = [];
      using _addSignal = stub(Deno, "addSignalListener", ((
        _signal,
        listener,
      ) => {
        stopChild = listener;
      }) as typeof Deno.addSignalListener);
      using _removeSignal = stub(
        Deno,
        "removeSignalListener",
        (() => {}) as typeof Deno.removeSignalListener,
      );
      using _kill = stub(Deno, "kill", ((pid, signal) => {
        killCalls.push({ pid, signal });
      }) as typeof Deno.kill);
      using _exit = stub(Deno, "exit", ((code) => {
        throw new Error(`exit ${code}`);
      }) as typeof Deno.exit);

      const run = captureConsole(() =>
        runMutationInSnapshot(["src/a.ts", "test/a.test.ts"], root),
      );
      const record = await waitForRunningRecord(root);

      expect(stopChild).toBeDefined();
      stopChild?.();
      expect(() => stopChild?.()).toThrow("exit 130");
      expect(killCalls).toEqual([
        { pid: record.pid, signal: "SIGTERM" },
        { pid: record.pid, signal: "SIGKILL" },
      ]);

      originalKill(record.pid!, "SIGKILL");
      expect((await run).result).not.toBe(0);
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

      const run = await captureConsole(() =>
        runMutationInSnapshot(["src/a.ts", "test/a.test.ts"], root),
      );
      const record = await readOnlyRunRecord(root);

      expect(run.result).toBe(1);
      expect(run.errors).toHaveLength(1);
      expect(run.errors[0]).toContain("missing-deno");
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
    });
  });
});
