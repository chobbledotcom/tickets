import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { runMutationInSnapshot } from "#scripts/mutation/isolation.ts";
import { runClaimPath } from "#scripts/mutation/isolation-state.ts";
import {
  captureConsole,
  withTempDir,
  writeFakeMutationScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { eventually } from "#test/scripts/stale-claim/helpers.ts";
import { pathExists } from "#test-utils/files.ts";
import {
  captureSimpleSnapshotMutation,
  controlledChild,
  failRunningStatusWrite,
  readOnlyRunRecord,
  sendFirstSignalImmediately,
  stubCommand,
  waitForRunningRecord,
  withCapturedStopChild,
} from "./helpers.ts";

describe("interrupting a snapshot run", () => {
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

        const stopChild = getStopChild();
        expect(stopChild).toBeDefined();
        if (!stopChild) return;
        stopChild();
        stopChild();
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
});
