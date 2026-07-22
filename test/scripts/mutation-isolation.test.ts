import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  copyMutationSnapshot,
  createRunId,
  formatRunList,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  readRunRecord,
  readRunRecords,
  rewriteMutationArgs,
  runLockIsHeld,
  runRoot,
  runStartedRecently,
  selectedRuns,
  shouldCopySnapshotPath,
  statusForExitCode,
  visibleStatus,
  withMutationRunLock,
  workRoot,
  writeRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import { pathExists } from "#test-utils/files.ts";
import {
  captureMutationCommand,
  runQuietMutationCommand,
  withTempDir,
  writeMovedRunRecord,
} from "./mutation-isolation-helpers.ts";

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

describe("mutation isolation paths", () => {
  test("copies source-like files and skips git, reports, secrets, dbs, and generated assets", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source");
      const snapshot = join(dir, "snapshot");
      await Deno.mkdir(join(source, "src", "ui", "static"), {
        recursive: true,
      });
      await Deno.mkdir(join(source, ".bin"), { recursive: true });
      await Deno.mkdir(join(source, ".git"), { recursive: true });
      await Deno.mkdir(join(source, "coverage"), { recursive: true });
      await Deno.writeTextFile(join(source, "src", "kept.ts"), "export {};\n");
      await Deno.writeTextFile(join(source, ".bin", "stripe-mock"), "mock");
      await Deno.writeTextFile(join(source, ".git", "config"), "git");
      await Deno.writeTextFile(join(source, "coverage", "lcov.info"), "cov");
      await Deno.writeTextFile(join(source, ".env"), "secret");
      await Deno.writeTextFile(join(source, "tickets.db"), "db");
      await Deno.writeTextFile(
        join(source, "src", "ui", "static", "app.js"),
        "js",
      );
      await Deno.writeTextFile(
        join(source, "src", "ui", "static", "style.css"),
        "css",
      );

      await copyMutationSnapshot(source, snapshot);

      expect(await Deno.readTextFile(join(snapshot, "src", "kept.ts"))).toBe(
        "export {};\n",
      );
      expect(
        await Deno.readTextFile(join(snapshot, ".bin", "stripe-mock")),
      ).toBe("mock");
      expect(await pathExists(join(snapshot, ".git", "config"))).toBe(false);
      expect(await pathExists(join(snapshot, "coverage", "lcov.info"))).toBe(
        false,
      );
      expect(await pathExists(join(snapshot, ".env"))).toBe(false);
      expect(await pathExists(join(snapshot, "tickets.db"))).toBe(false);
      expect(
        await pathExists(join(snapshot, "src", "ui", "static", "app.js")),
      ).toBe(false);
      expect(
        await pathExists(join(snapshot, "src", "ui", "static", "style.css")),
      ).toBe(false);
    });
  });

  test("states which paths belong in a snapshot", () => {
    expect(shouldCopySnapshotPath("")).toBe(true);
    expect(shouldCopySnapshotPath("src/shared/dates.ts")).toBe(true);
    expect(shouldCopySnapshotPath(".mutation-runs/run/work")).toBe(false);
    expect(shouldCopySnapshotPath(".jscpd-report/index.html")).toBe(false);
    expect(shouldCopySnapshotPath("coverage-test/lcov.info")).toBe(false);
    expect(shouldCopySnapshotPath("local.db-wal")).toBe(false);
    expect(shouldCopySnapshotPath("src/ui/static/order.js")).toBe(false);
  });

  test("rewrites only absolute project paths", () => {
    const root = "/repo/tickets";
    const snapshot = "/repo/tickets/.mutation-runs/run/work";

    expect(
      rewriteMutationArgs(root, snapshot, [
        "--source",
        "/repo/tickets",
        "/repo/tickets/src/a.ts",
        "test/a.test.ts",
        "--harness",
        "/tmp/outside.ts",
      ]),
    ).toEqual([
      "--source",
      "/repo/tickets/.mutation-runs/run/work",
      "/repo/tickets/.mutation-runs/run/work/src/a.ts",
      "test/a.test.ts",
      "--harness",
      "/tmp/outside.ts",
    ]);
    expect(rewriteMutationArgs("/", "/snapshot", ["/repo/tickets"])).toEqual([
      "/snapshot/repo/tickets",
    ]);
  });
});

describe("mutation isolation run records", () => {
  test("creates deterministic ids and records state transitions", () => {
    const id = createRunId(new Date("2026-07-09T12:34:56.789Z"), "abc12345");
    expect(id).toBe("mutation-20260709T123456Z-abc12345");

    const record = newRunRecord(id, ["src/a.ts", "test/a.test.ts"], "/repo");
    expect(record.status).toBe("copying");
    expect(record.workRoot).toBe(workRoot(id, "/repo"));

    const running = markRunning(record, 42, "2026-07-09T12:35:00.000Z");
    expect(running).toMatchObject({ pid: 42, status: "running" });
    expect(markFinished(running, 0)).toMatchObject({
      exitCode: 0,
      status: "passed",
    });
    expect(markFinished(running, 1)).toMatchObject({
      exitCode: 1,
      status: "failed",
    });
    expect(markInterrupted(running)).toMatchObject({
      exitCode: 130,
      status: "interrupted",
    });
  });

  test("maps exit codes to run status", () => {
    expect(statusForExitCode(0)).toBe("passed");
    expect(statusForExitCode(130)).toBe("interrupted");
    expect(statusForExitCode(2)).toBe("failed");
  });

  test("treats a run as recently started only within the grace period", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const fresh = markRunning(
      newRunRecord("fresh", [], "/repo", "2026-07-10T11:59:45.000Z"),
      1,
      "2026-07-10T11:59:45.000Z",
    );
    const stale = markRunning(
      newRunRecord("stale", [], "/repo", "2026-07-10T11:00:00.000Z"),
      2,
      "2026-07-10T11:00:00.000Z",
    );
    expect(runStartedRecently(fresh, now)).toBe(true);
    expect(runStartedRecently(stale, now)).toBe(false);
  });

  test("writes, reads, sorts, and ignores broken records", async () => {
    await withTempDir(async (root) => {
      expect(await readRunRecords(root)).toEqual([]);

      const older = newRunRecord("older", [], root, "2026-07-09T10:00:00.000Z");
      const newer = newRunRecord("newer", [], root, "2026-07-09T11:00:00.000Z");
      await writeRunRecord(older);
      await writeRunRecord(newer);
      await Deno.mkdir(join(root, ".mutation-runs", "broken"), {
        recursive: true,
      });
      await Deno.writeTextFile(join(root, ".mutation-runs", "not-a-dir"), "");
      await Deno.writeTextFile(
        join(root, ".mutation-runs", "broken", "run.json"),
        "{not-json",
      );

      const records = await readRunRecords(root);
      expect(records.map((record) => record.id)).toEqual(["newer", "older"]);
      expect(await readRunRecord(join(root, "missing.json"))).toBeNull();
    });
  });

  test("reads records from the current run directory", async () => {
    await withTempDir(async (root) => {
      const { id, record } = await writeMovedRunRecord(root);

      expect(await readRunRecords(root)).toEqual([
        {
          ...record,
          root: runRoot(id, root),
          workRoot: workRoot(id, root),
        },
      ]);
    });
  });

  test("surfaces unreadable run directories", async () => {
    await withTempDir(async (root) => {
      const fileRoot = join(root, "file-root");
      await Deno.writeTextFile(fileRoot, "");

      await expect(readRunRecords(fileRoot)).rejects.toThrow(
        Deno.errors.NotADirectory,
      );
    });
  });

  test("reports whether a run lock is held", async () => {
    await withTempDir(async (root) => {
      const record = { root };
      expect(await runLockIsHeld(record, 100)).toBe(false);
      await withMutationRunLock(root, async () => {
        expect(await runLockIsHeld(record, 100)).toBe(true);
      });
      expect(await runLockIsHeld(record, 100)).toBe(false);

      const fileRoot = join(root, "file-root");
      await Deno.writeTextFile(fileRoot, "");
      expect(await runLockIsHeld({ root: fileRoot }, 100)).toBe(false);
    });
  });
});

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
