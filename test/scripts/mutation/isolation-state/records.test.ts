import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createRunId,
  isRunId,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  statusForExitCode,
  workRoot,
} from "#scripts/mutation/isolation-state.ts";

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

  test("gives each run a plain id with an eight-letter tail", () => {
    const id = createRunId();
    const tail = id.split("-").at(-1);

    // Two runs started in the same second must still land in their own folder.
    expect(tail).toHaveLength(8);
    expect(id.startsWith("mutation-")).toBe(true);
    expect(createRunId()).not.toBe(id);
  });

  test("knows which folder names are its own runs", () => {
    expect(isRunId(createRunId())).toBe(true);
    // Named by someone else, so never ours to clear away.
    expect(isRunId("mutation-backups")).toBe(false);
    expect(isRunId("mutation-20260709T123456Z-nothex!")).toBe(false);
  });
});
