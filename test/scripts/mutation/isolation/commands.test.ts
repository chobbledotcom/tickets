import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { withMutationRunLock } from "#scripts/mutation/isolation-lock.ts";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  markFinished,
  markRunning,
  newRunRecord,
  runRoot,
  runStartedRecently,
} from "#scripts/mutation/isolation-state.ts";
import {
  captureMutationCommand,
  finishedRun,
  LONG_AGO,
  runIdNamed,
  runningRun,
  runningWithoutPid,
  runQuietMutationCommand,
  withTempDir,
  writeMovedRunRecord,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";

const cleanPassedRunWithRemoveError = async (
  root: string,
  error: unknown,
): Promise<{
  clean: Awaited<ReturnType<typeof captureMutationCommand>>;
  passed: ReturnType<typeof markFinished>;
}> => {
  const passed = markFinished(newRunRecord(runIdNamed("passed"), [], root), 0);
  await writeRunRecord(passed);

  const remove = Deno.remove;
  using _remove = stub(Deno, "remove", ((path, options) => {
    if (String(path) === passed.root) return Promise.reject(error);
    return remove(path, options);
  }) as typeof Deno.remove);

  const clean = await captureMutationCommand(
    ["--clean", runIdNamed("passed")],
    root,
  );
  return { clean, passed };
};

const expectCleanPassedRunRemovalFailure = async (
  root: string,
  error: unknown,
): Promise<void> => {
  const { clean, passed } = await cleanPassedRunWithRemoveError(root, error);

  expect(clean).toEqual({
    errors: [`Failed to remove ${runIdNamed("passed")}: permission denied`],
    logs: [],
    result: 1,
  });
  expect(await pathExists(passed.root)).toBe(true);
};

describe("mutation isolation commands", () => {
  test("cleans only the current run directory", async () => {
    await withTempDir(async (root) => {
      const { id, oldRunRoot } = await writeMovedRunRecord(root);
      await Deno.mkdir(oldRunRoot, { recursive: true });
      await Deno.writeTextFile(join(oldRunRoot, "keep.txt"), "old");

      expect(await runQuietMutationCommand(["--clean", "all"], root)).toBe(0);

      expect(await pathExists(runRoot(id, root))).toBe(false);
      expect(await pathExists(join(oldRunRoot, "keep.txt"))).toBe(true);
    });
  });

  test("skips active runs during cleanup", async () => {
    await withTempDir(async (root) => {
      const copying = newRunRecord(runIdNamed("copying"), [], root);
      // Old enough that the startup grace no longer covers it.
      const staleCopying = newRunRecord(
        runIdNamed("stale-copying"),
        [],
        root,
        LONG_AGO.toISOString(),
      );
      const running = markRunning(
        newRunRecord(runIdNamed("running"), [], root),
        Deno.pid,
      );
      const starting = markRunning(
        newRunRecord(runIdNamed("starting"), [], root),
        Deno.pid,
      );
      const stale = runningRun("stale", root, 99_999_999);
      const noPid = runningWithoutPid("nopid", root);
      const passed = finishedRun("passed", root);
      for (const record of [
        copying,
        staleCopying,
        running,
        starting,
        stale,
        noPid,
        passed,
      ]) {
        await writeRunRecord(record);
      }

      expect(
        await runQuietMutationCommand(
          ["--clean", runIdNamed("starting")],
          root,
        ),
      ).toBe(1);
      await withMutationRunLock(copying.root, async () => {
        await withMutationRunLock(running.root, async () => {
          expect(
            await runQuietMutationCommand(
              ["--clean", runIdNamed("running")],
              root,
            ),
          ).toBe(1);
          expect(await runQuietMutationCommand(["--clean", "all"], root)).toBe(
            0,
          );
        });
      });

      expect(await pathExists(copying.root)).toBe(true);
      expect(await pathExists(staleCopying.root)).toBe(false);
      expect(await pathExists(running.root)).toBe(true);
      expect(await pathExists(starting.root)).toBe(true);
      expect(await pathExists(stale.root)).toBe(false);
      expect(await pathExists(noPid.root)).toBe(false);
      expect(await pathExists(passed.root)).toBe(false);
    });
  });

  test("cleans stale running records whose pid was reused after the grace period", async () => {
    await withTempDir(async (root) => {
      const staleReused = markRunning(
        newRunRecord(
          runIdNamed("stale-reused"),
          [],
          root,
          LONG_AGO.toISOString(),
        ),
        Deno.pid,
        LONG_AGO.toISOString(),
      );
      await writeRunRecord(staleReused);

      expect(runStartedRecently(staleReused)).toBe(false);

      expect(
        await runQuietMutationCommand(
          ["--clean", runIdNamed("stale-reused")],
          root,
        ),
      ).toBe(0);
      expect(await pathExists(staleReused.root)).toBe(false);
    });
  });

  test("reports cleanup removal failures", async () => {
    await withTempDir(async (root) => {
      await expectCleanPassedRunRemovalFailure(
        root,
        new Error("permission denied"),
      );
    });
  });

  test("treats missing run directories as already removed", async () => {
    await withTempDir(async (root) => {
      const { clean } = await cleanPassedRunWithRemoveError(
        root,
        new Deno.errors.NotFound("already gone"),
      );

      expect(clean).toEqual({
        errors: [],
        logs: [`Removed ${runIdNamed("passed")}.`],
        result: 0,
      });
    });
  });

  test("reports cleanup removal failures from thrown values", async () => {
    await withTempDir(async (root) => {
      await expectCleanPassedRunRemovalFailure(root, "permission denied");
    });
  });
});
