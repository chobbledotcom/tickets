import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  runLockIsHeld,
  withMutationRunLock,
} from "#scripts/mutation/isolation-lock.ts";
import {
  readRunRecord,
  readRunRecords,
  writeRunRecord,
} from "#scripts/mutation/isolation-records.ts";
import {
  createRunId,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  recordPath,
  runRoot,
  runStartedRecently,
  statusForExitCode,
  workRoot,
} from "#scripts/mutation/isolation-state.ts";
import {
  withTempDir,
  writeMovedRunRecord,
} from "#test/scripts/mutation/isolation-helpers.ts";

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

  test("keeps the last complete record readable while writing a new one", async () => {
    await withTempDir(async (root) => {
      const record = newRunRecord("swap", [], root);
      await writeRunRecord(record);

      // Stop the swap half way, which is where a reader could catch a partly
      // written record if the new text went straight into run.json.
      const rename = Deno.rename;
      const swapping = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      using _rename = stub(Deno, "rename", (async (
        from: string | URL,
        to: string | URL,
      ) => {
        swapping.resolve();
        await held.promise;
        await rename(from, to);
      }) as typeof Deno.rename);

      const writing = writeRunRecord(markRunning(record, 4242));
      // Read only once the swap is under way, or this would prove nothing.
      await swapping.promise;
      expect(await readRunRecord(recordPath("swap", root))).toMatchObject({
        status: "copying",
      });

      held.resolve();
      await writing;
      expect(await readRunRecord(recordPath("swap", root))).toMatchObject({
        pid: 4242,
        status: "running",
      });
    });
  });

  test("treats a record whose time makes no sense as not started recently", () => {
    const broken = markRunning(
      newRunRecord("broken", [], "/repo", "not a time"),
      3,
      "not a time",
    );

    expect(
      runStartedRecently(broken, new Date("2026-07-10T12:00:00.000Z")),
    ).toBe(false);
  });

  test("treats a run stamped in the future as not recent", () => {
    // A clock put back must not leave a dead run looking busy for ever.
    const future = markRunning(
      newRunRecord("future", [], "/repo", "2027-01-01T00:00:00.000Z"),
      5,
      "2027-01-01T00:00:00.000Z",
    );

    expect(
      runStartedRecently(future, new Date("2026-07-10T12:00:00.000Z")),
    ).toBe(false);
  });

  test("counts a run stamped a moment after the epoch", () => {
    const justAfterEpoch = markRunning(
      newRunRecord("epoch", [], "/repo", "1970-01-01T00:00:00.001Z"),
      4,
      "1970-01-01T00:00:00.001Z",
    );

    expect(runStartedRecently(justAfterEpoch, new Date(1), 1000)).toBe(true);
  });

  test("gives each run a plain id with an eight-letter tail", () => {
    const id = createRunId();
    const tail = id.split("-").at(-1);

    // Two runs started in the same second must still land in their own folder.
    expect(tail).toHaveLength(8);
    expect(id.startsWith("mutation-")).toBe(true);
    expect(createRunId()).not.toBe(id);
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

  test("writes the record so a person can read it", async () => {
    await withTempDir(async (root) => {
      const record = newRunRecord("readable", ["src/a.ts"], root);
      await writeRunRecord(record);

      const written = await Deno.readTextFile(
        join(root, ".mutation-runs", "readable", "run.json"),
      );

      // Indented and one line per field, so `cat run.json` is worth doing.
      expect(written.split("\n")[1]).toBe('  "args": [');
      expect(written.endsWith("}\n")).toBe(true);
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
