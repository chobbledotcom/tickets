import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { runMutationInSnapshot } from "#scripts/mutation/isolation.ts";
import { MUTATION_SNAPSHOT_CHILD_ENV } from "#scripts/mutation/isolation-state.ts";
import {
  captureConsole,
  captureMutationCommand,
  withTempDir,
  writeFakeMutationScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";
import {
  capturePlainSnapshotFailure,
  captureSimpleSnapshotMutation,
  controlledChild,
  failRunningStatusWrite,
  failTextFileWrites,
  finishedChild,
  readOnlyRunRecord,
  recordAroundClean,
  SNAPSHOT_FAILED,
  sendFirstSignalImmediately,
  stubCommand,
  waitForRecord,
  waitForRunningRecord,
  withCapturedStopChild,
} from "./helpers.ts";

describe("running mutation inside a snapshot", () => {
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
      // The pid is printed so a stray run can be found and stopped by hand.
      expect(run.logs).toContain(`Mutation child pid ${record.pid}`);
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(7);
      expect(record.args).toEqual(["src/a.ts", join(root, "test/a.test.ts")]);
      expect(typeof record.pid).toBe("number");
      expect(
        await pathExists(join(record.workRoot, "scripts", "mutation.ts")),
      ).toBe(true);
    });
  });

  test("tells the child it is running inside a snapshot", async () => {
    await withTempDir(async (root) => {
      const starts: Deno.CommandOptions[] = [];
      using _command = stubCommand(finishedChild(42_426), starts);

      await captureSimpleSnapshotMutation(root);

      expect(starts[0]?.env?.[MUTATION_SNAPSHOT_CHILD_ENV]).toBe("1");
    });
  });

  test("writes the run record before it queues for the lock", async () => {
    await withTempDir(async (root) => {
      // A record on disk this early is what makes a queued run findable.
      expect((await recordAroundClean(root)).beforeLock).toBe(true);
    });
  });

  test("writes the run record again if a clean removes it while queueing", async () => {
    await withTempDir(async (root) => {
      // The clean above dropped the record; the run must put it back, or the
      // snapshot it is about to make would belong to no run anyone can find.
      expect((await recordAroundClean(root)).atChildStart).toBe(true);
    });
  });

  test("gives up waiting when no run record ever appears", async () => {
    await withTempDir(async (root) => {
      await expect(
        waitForRecord(root, (records) => records[0], "no record", 2),
      ).rejects.toThrow("no record");
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
      using _command = stubCommand(process.child);

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

  test("gives a stopping child a moment to end before forcing it", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      const killCalls: (Deno.Signal | undefined)[] = [];
      // The child takes a moment to end, well inside the grace period.
      const process = controlledChild(42_425, (signal, finish) => {
        killCalls.push(signal);
        setTimeout(
          () => finish({ code: 143, signal: "SIGTERM", success: false }),
          50,
        );
      });
      using _command = stubCommand(process.child);
      using _writeTextFile = failRunningStatusWrite();

      await captureSimpleSnapshotMutation(root);

      // Only the polite signal: it ended on its own, so it was never forced.
      expect(killCalls).toEqual([undefined]);
    });
  });

  test("records interrupted when a running child exits after a signal", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "await new Promise(() => {});\n");

      await withCapturedStopChild(async (getStopChild) => {
        const run = captureSimpleSnapshotMutation(root);
        await waitForRunningRecord(root);

        getStopChild()?.();
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
      using _command = stubCommand(process.child);

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
