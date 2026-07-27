import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  markFinished,
  markRunning,
  newRunRecord,
  runRoot,
  runStartedRecently,
  withMutationRunLock,
  writeRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  captureMutationCommand,
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
  const passed = markFinished(newRunRecord("mutation-passed", [], root), 0);
  await writeRunRecord(passed);

  const remove = Deno.remove;
  using _remove = stub(Deno, "remove", ((path, options) => {
    if (String(path) === passed.root) return Promise.reject(error);
    return remove(path, options);
  }) as typeof Deno.remove);

  const clean = await captureMutationCommand(
    ["--clean", "mutation-passed"],
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
    errors: ["Failed to remove mutation-passed: permission denied"],
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
      const copying = newRunRecord("mutation-copying", [], root);
      // Old enough that the startup grace no longer covers it.
      const staleCopying = newRunRecord(
        "mutation-stale-copying",
        [],
        root,
        "2026-01-01T00:00:00.000Z",
      );
      const running = markRunning(
        newRunRecord("mutation-running", [], root),
        Deno.pid,
      );
      const starting = markRunning(
        newRunRecord("mutation-starting", [], root),
        Deno.pid,
      );
      const stale = markRunning(
        newRunRecord("mutation-stale", [], root),
        99_999_999,
      );
      const noPid = {
        ...newRunRecord("mutation-nopid", [], root),
        status: "running" as const,
      };
      const passed = markFinished(newRunRecord("mutation-passed", [], root), 0);
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
        await runQuietMutationCommand(["--clean", "mutation-starting"], root),
      ).toBe(1);
      await withMutationRunLock(copying.root, async () => {
        await withMutationRunLock(running.root, async () => {
          expect(
            await runQuietMutationCommand(
              ["--clean", "mutation-running"],
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
          "mutation-stale-reused",
          [],
          root,
          "2026-01-01T00:00:00.000Z",
        ),
        Deno.pid,
        "2026-01-01T00:00:00.000Z",
      );
      await writeRunRecord(staleReused);

      expect(runStartedRecently(staleReused)).toBe(false);

      expect(
        await runQuietMutationCommand(
          ["--clean", "mutation-stale-reused"],
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
        logs: ["Removed mutation-passed."],
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
