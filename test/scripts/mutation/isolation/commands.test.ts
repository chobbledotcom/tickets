import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  markFinished,
  markRunning,
  newRunRecord,
  runRoot,
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
  writeRunClaim,
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

  test("skips claimed runs during cleanup", async () => {
    await withTempDir(async (root) => {
      // Claimed by a live supervisor, so kept whatever the record says.
      const copying = newRunRecord(runIdNamed("copying"), [], root);
      const running = markRunning(
        newRunRecord(runIdNamed("running"), [], root),
        Deno.pid,
      );
      // Records with nobody's claim behind them, so all cleanable — even ones
      // written moments ago, and even when the process id in them is alive.
      const staleCopying = newRunRecord(runIdNamed("stale-copying"), [], root);
      const unclaimed = runningRun("unclaimed", root, Deno.pid);
      const stale = runningRun("stale", root, 99_999_999);
      const noPid = runningWithoutPid("nopid", root);
      const passed = finishedRun("passed", root);
      for (const record of [
        copying,
        staleCopying,
        running,
        unclaimed,
        stale,
        noPid,
        passed,
      ]) {
        await writeRunRecord(record);
      }
      await writeRunClaim(copying);
      await writeRunClaim(running);

      expect(
        await runQuietMutationCommand(["--clean", runIdNamed("running")], root),
      ).toBe(1);
      expect(await runQuietMutationCommand(["--clean", "all"], root)).toBe(0);

      expect(await pathExists(copying.root)).toBe(true);
      expect(await pathExists(running.root)).toBe(true);
      expect(await pathExists(staleCopying.root)).toBe(false);
      expect(await pathExists(unclaimed.root)).toBe(false);
      expect(await pathExists(stale.root)).toBe(false);
      expect(await pathExists(noPid.root)).toBe(false);
      expect(await pathExists(passed.root)).toBe(false);
    });
  });

  test("cleans a running record whose claim went stale, whatever its pid says", async () => {
    await withTempDir(async (root) => {
      // The supervisor died and its process id has since been handed to a
      // live process; the walked-away claim is what tells the truth.
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
      await writeRunClaim(staleReused, LONG_AGO.getTime());

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
