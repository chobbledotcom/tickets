import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  runIsolatedMutationCommand,
  runMutationInSnapshot,
} from "#scripts/mutation/isolation.ts";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  createRunId,
  MUTATION_RECORD_FILE,
  MUTATION_SNAPSHOT_CHILD_ENV,
  markFinished,
  newRunRecord,
  runClaimPath,
} from "#scripts/mutation/isolation-state.ts";
import {
  captureConsole,
  captureMutationCommand,
  withTempDir,
  writeFakeMutationScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { eventually } from "#test/scripts/stale-claim/helpers.ts";
import { pathExists } from "#test-utils/files.ts";
import {
  capturePlainSnapshotFailure,
  captureSimpleSnapshotMutation,
  controlledChild,
  failRunningStatusWrite,
  failSnapshotRead,
  failTextFileWrites,
  failWorkRemoval,
  finishedChild,
  readOnlyRunRecord,
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
      expect(
        run.logs.some((line) => /^Mutation child pid \d+$/.test(line)),
      ).toBe(true);
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(7);
      expect(record.args).toEqual(["src/a.ts", join(root, "test/a.test.ts")]);
      // The child is gone by the time the record settles, and its id with it.
      expect(record.pid).toBeUndefined();
    });
  });

  test("throws away the snapshot once the run has ended", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      await captureSimpleSnapshotMutation(root);
      const record = await readOnlyRunRecord(root);

      // The snapshot is a whole copy of the checkout, so it must not be left
      // behind; the small record stays so the run is still listed.
      expect(await pathExists(record.workRoot)).toBe(false);
      expect(await pathExists(join(record.root, MUTATION_RECORD_FILE))).toBe(
        true,
      );
    });
  });

  test("reports a snapshot it cannot throw away", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");

      const run = await (async () => {
        using _remove = failWorkRemoval();
        return await captureSimpleSnapshotMutation(root);
      })();

      expect(run.errors).toEqual([
        `Failed to remove the snapshot of ${(await readOnlyRunRecord(root)).id}: work is busy`,
      ]);
    });
  });

  test("says nothing when the snapshot is already gone", async () => {
    await withTempDir(async (root) => {
      // The child tidies its own snapshot away before the run ends.
      await writeFakeMutationScript(
        root,
        "Deno.removeSync(Deno.cwd(), { recursive: true });\nDeno.exit(0);\n",
      );

      const run = await captureSimpleSnapshotMutation(root);

      expect(run.errors).toEqual([]);
      expect(await pathExists((await readOnlyRunRecord(root)).workRoot)).toBe(
        false,
      );
    });
  });

  test("clears out runs that ended earlier before starting a new one", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const old = markFinished(newRunRecord(createRunId(), [], root), 0);
      await writeRunRecord(old);
      await Deno.mkdir(old.workRoot, { recursive: true });

      await captureSimpleSnapshotMutation(root);

      expect(await pathExists(old.root)).toBe(false);
      // Only the run that just happened is left.
      expect((await readOnlyRunRecord(root)).id).not.toBe(old.id);
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

  test("keeps its folder claimed against a clean while the run is going", async () => {
    await withTempDir(async (root) => {
      const child = controlledChild(42_427, () => {});
      using _command = stubCommand(child.child);

      const run = captureSimpleSnapshotMutation(root);
      const started = await waitForRunningRecord(root);

      // A `--clean` sweeping mid-run finds the folder claimed and leaves it.
      expect(await runIsolatedMutationCommand(["--clean", "all"], root)).toBe(
        1,
      );
      expect(await pathExists(started.root)).toBe(true);

      child.finish({ code: 0, signal: null, success: true });
      expect((await run).result).toBe(0);
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
      const run = await (async () => {
        using _readDir = failSnapshotRead(SNAPSHOT_FAILED, () => {
          copyFailed = true;
        });
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

  test("publishes the pid-less record the moment the child ends", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const written: { pid?: number; status: string }[] = [];
      const writeTextFile = Deno.writeTextFile;
      using _write = stub(Deno, "writeTextFile", ((
        target: string | URL,
        data: string | ReadableStream<string>,
        options?: Deno.WriteFileOptions,
      ) => {
        // Records land in a pending file first, so match by name, not tail.
        if (
          `${target}`.includes(MUTATION_RECORD_FILE) &&
          typeof data === "string"
        ) {
          written.push(JSON.parse(data));
        }
        return writeTextFile(target, data, options);
      }) as typeof Deno.writeTextFile);

      await captureSimpleSnapshotMutation(root);

      // The pid leaves the written record the moment the child ends — before
      // the kept files come back — so --kill can never trust it late.
      const running = written.filter((record) => record.status === "running");
      expect(running.at(0)?.pid).toBeGreaterThan(0);
      expect(running.at(-1)?.pid).toBeUndefined();
    });
  });

  test("escalates repeated interrupts", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "await new Promise(() => {});\n");

      const exitCodes: number[] = [];
      using _exit = stub(Deno, "exit", ((code?: number) => {
        exitCodes.push(code ?? 0);
      }) as unknown as typeof Deno.exit);
      await withCapturedStopChild(async (getStopChild) => {
        // The failure is expected and caught from the very start: it can
        // land while the test is still watching for the claim to go.
        const run = (async () => {
          try {
            await captureSimpleSnapshotMutation(root);
            return null;
          } catch (error) {
            return error;
          }
        })();
        const record = await waitForRunningRecord(root);

        expect(getStopChild()).toBeDefined();
        getStopChild()?.();
        getStopChild()?.();
        // The forced stop takes the claim down — under the takers' guard,
        // so a child touch mid-write cannot put it back — and then exits:
        // the run reads as over at once, not after a whole stale window.
        await eventually(
          async () => !(await pathExists(runClaimPath({ root: record.root }))),
        );
        expect(exitCodes).toEqual([130]);

        // Only because the test stubbed the exit away does the run carry on
        // to its release, which finds the claim gone — in production the
        // process is over the moment the claim comes down.
        expect(String(await run)).toContain("was lost while the work ran");
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
