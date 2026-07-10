import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runLockIsHeld,
  withMutationRunLock,
} from "../../scripts/mutation/isolation-lock.ts";
import {
  createRunId,
  formatRunList,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  readRunRecord,
  readRunRecords,
  runRoot,
  runStartedRecently,
  selectedRuns,
  statusForExitCode,
  visibleStatus,
  workRoot,
  writeRunRecord,
} from "../../scripts/mutation/isolation-state.ts";
import {
  withTempDir,
  writeMovedRunRecord,
} from "./mutation-isolation-helpers.ts";

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
      expect(await runLockIsHeld(record, 10)).toBe(false);
      await withMutationRunLock(root, async () => {
        expect(await runLockIsHeld(record, 10)).toBe(true);
      });
      expect(await runLockIsHeld(record, 10)).toBe(false);

      const fileRoot = join(root, "file-root");
      await Deno.writeTextFile(fileRoot, "");
      expect(await runLockIsHeld({ root: fileRoot }, 10)).toBe(false);
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
});
