import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { SNAPSHOT_PROGRESS } from "#scripts/database-snapshot-lib.ts";
import { createSnapshotProgressOutput } from "#scripts/database-snapshot-output.ts";

describe("database snapshot progress output", () => {
  test("writes stable progress lines when output is redirected", () => {
    const output: string[] = [];
    const progress = createSnapshotProgressOutput({
      terminal: false,
      write: (text) => output.push(text),
    });

    progress.report(SNAPSHOT_PROGRESS.checking);
    progress.report(SNAPSHOT_PROGRESS.syncing);
    progress.stop();

    expect(output.join("")).toBe(
      "[1/4] Checking destination\n[2/4] Syncing remote database\n",
    );
  });

  test("refreshes elapsed time on an active terminal line", async () => {
    using time = new FakeTime(0);
    const output: string[] = [];
    const progress = createSnapshotProgressOutput({
      terminal: true,
      write: (text) => output.push(text),
    });

    progress.report(SNAPSHOT_PROGRESS.checking);
    await time.tickAsync(1_001);
    progress.report(SNAPSHOT_PROGRESS.syncing);
    await time.tickAsync(2_100);
    progress.stop();

    expect(output.join("")).toBe(
      "\r\x1b[2K[1/4] Checking destination" +
        "\r\x1b[2K[1/4] Checking destination (1s)\n" +
        "\r\x1b[2K[2/4] Syncing remote database" +
        "\r\x1b[2K[2/4] Syncing remote database (1s)" +
        "\r\x1b[2K[2/4] Syncing remote database (2s)\n",
    );
  });

  test("can stop before progress starts", () => {
    const progress = createSnapshotProgressOutput({
      terminal: true,
      write: () => {
        throw new Error("write should not be called");
      },
    });

    progress.stop();
  });
});
