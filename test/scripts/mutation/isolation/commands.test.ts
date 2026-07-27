import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  formatRunList,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  runRoot,
  runStartedRecently,
  selectedRuns,
  visibleStatus,
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
  test("parses management commands and passes mutation args through", () => {
    expect(parseIsolationCommand([])).toEqual({
      kind: "invalid",
      message: "Mutation source and test globs are required.",
    });
    expect(parseIsolationCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseIsolationCommand(["--list"])).toEqual({ kind: "list" });
    expect(parseIsolationCommand(["kill", "run-1", "--force"])).toEqual({
      force: true,
      kind: "kill",
      target: "run-1",
    });
    expect(parseIsolationCommand(["--kill"])).toEqual({
      kind: "invalid",
      message: "A run id or all is required for --kill.",
    });
    expect(parseIsolationCommand(["clean", "finished"])).toEqual({
      kind: "clean",
      target: "finished",
    });
    expect(parseIsolationCommand(["clean"])).toEqual({
      kind: "invalid",
      message: "A run id, all, or finished is required for --clean.",
    });
    expect(parseIsolationCommand(["src/a.ts", "test/a.test.ts"])).toEqual({
      args: ["src/a.ts", "test/a.test.ts"],
      kind: "run",
    });
  });

  test("selects records by target", () => {
    const running = markRunning(
      newRunRecord("mutation-running", ["src/a.ts"], "/repo"),
      10,
    );
    const copying = newRunRecord("mutation-copying", ["src/c.ts"], "/repo");
    const passed = markFinished(
      newRunRecord("mutation-passed", ["src/b.ts"], "/repo"),
      0,
    );
    const failed = markFinished(
      newRunRecord("mutation-failed", ["src/d.ts"], "/repo"),
      1,
    );
    const interrupted = markInterrupted(
      newRunRecord("mutation-interrupted", ["src/e.ts"], "/repo"),
    );
    const records = [running, copying, passed, failed, interrupted];

    expect(selectedRuns(records, "all").map((record) => record.id)).toEqual([
      "mutation-running",
      "mutation-copying",
      "mutation-passed",
      "mutation-failed",
      "mutation-interrupted",
    ]);
    expect(
      selectedRuns(records, "finished").map((record) => record.id),
    ).toEqual(["mutation-passed", "mutation-failed", "mutation-interrupted"]);
    expect(selectedRuns(records, "mutation-running")).toEqual([running]);
    expect(selectedRuns(records, "mutation-runn")).toEqual([running]);
    expect(selectedRuns(records, "mutation-")).toEqual([]);
    expect(selectedRuns(records, "missing")).toEqual([]);
  });

  test("formats list output", () => {
    const running = markRunning(
      newRunRecord("mutation-running", ["src/a.ts"], "/repo"),
      10,
    );

    expect(visibleStatus(running, false)).toBe("stale");
    expect(formatRunList([], new Set(), "/repo")).toEqual([
      "No isolated mutation runs.",
    ]);
    expect(
      formatRunList([running], new Set(["mutation-running"]), "/repo"),
    ).toEqual([
      "mutation-running running pid=10 exit=- work=.mutation-runs/mutation-running/work args=src/a.ts",
    ]);
    expect(formatRunList([running], new Set(), "/repo")).toEqual([
      "mutation-running stale pid=10 exit=- work=.mutation-runs/mutation-running/work args=src/a.ts",
    ]);
    expect(
      formatRunList([markFinished(running, 1)], new Set(), "/repo"),
    ).toEqual([
      "mutation-running failed pid=10 exit=1 work=.mutation-runs/mutation-running/work args=src/a.ts",
    ]);
    expect(
      formatRunList([newRunRecord("empty", [], "/repo")], new Set(), "/repo"),
    ).toEqual(["empty copying pid=- exit=- work=.mutation-runs/empty/work"]);
  });

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
      const staleCopying = newRunRecord("mutation-stale-copying", [], root);
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
