import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { runMutationInSnapshot } from "#scripts/mutation/isolation.ts";
import {
  MUTATION_SNAPSHOT_CHILD_ENV,
  withMutationRunLock,
} from "#scripts/mutation/isolation-state.ts";
import {
  captureConsole,
  captureMutationCommand,
  runQuietMutationCommand,
  withTempDir,
  writeFakeMutationScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";
import {
  capturePlainSnapshotFailure,
  captureSimpleSnapshotMutation,
  childCommand,
  controlledChild,
  denoCommand,
  failRunningStatusWrite,
  failTextFileWrites,
  readOnlyRunRecord,
  SNAPSHOT_FAILED,
  sendFirstSignalImmediately,
  waitForRunningRecord,
  waitForRunRecord,
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
      expect(
        run.logs.some((line) =>
          new RegExp(`^Mutation child pid ${record.pid}$`).test(line),
        ),
      ).toBe(true);
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
      const marker = join(root, "child-env.txt");
      await writeFakeMutationScript(
        root,
        `await Deno.writeTextFile(${JSON.stringify(marker)},\n` +
          `  Deno.env.get(${JSON.stringify(MUTATION_SNAPSHOT_CHILD_ENV)}) ?? "unset");\n`,
      );

      await runQuietMutationCommand(
        ["src/a.ts", join(root, "test/a.test.ts")],
        root,
      );

      expect(await Deno.readTextFile(marker)).toBe("1");
    });
  });

  test("writes the run record before waiting for the lock", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const holderInside = Promise.withResolvers<void>();
      const releaseHolder = Promise.withResolvers<void>();

      // Hold the run lock, so the run below cannot get past it.
      const holding = withMutationRunLock(
        join(root, ".mutation-runs"),
        async () => {
          holderInside.resolve();
          await releaseHolder.promise;
        },
      );
      await holderInside.promise;

      const running = runQuietMutationCommand(
        ["src/a.ts", join(root, "test/a.test.ts")],
        root,
      );
      // The record must be on disk while the run is still queued, so a stray
      // run is findable before it ever starts.
      await waitForRunRecord(root);

      releaseHolder.resolve();
      await holding;
      await running;
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
      using _command = stub(
        denoCommand,
        "Command",
        childCommand(process.child),
      );
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
