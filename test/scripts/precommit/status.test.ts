import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import * as v from "valibot";
import { precommitLockAt } from "#scripts/precommit/lock.ts";
import { runChecksBeforePush } from "#scripts/precommit/run-order.ts";
import { runWithPrecommitStatus } from "#scripts/precommit/status.ts";
import {
  type PrecommitStatus,
  PrecommitStatusFilenameSchema,
  PrecommitStatusSchema,
} from "#scripts/precommit/status-schema.ts";

describe("precommit status producer", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await Deno.makeTempDir();
  });
  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  const records = async (): Promise<PrecommitStatus[]> => {
    const result: PrecommitStatus[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.name.endsWith(".json")) continue;
      v.parse(PrecommitStatusFilenameSchema, entry.name);
      result.push(
        v.parse(
          PrecommitStatusSchema,
          JSON.parse(await Deno.readTextFile(join(directory, entry.name))),
        ),
      );
    }
    return result;
  };

  const record = async (): Promise<PrecommitStatus> => {
    const found = await records();
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  test("persists transitions without a heartbeat or private data", async () => {
    using time = new FakeTime("2026-09-10T10:00:00.000Z");
    const createdAt = new Date().toISOString();
    const result = await runWithPrecommitStatus(async (status) => {
      expect(await record()).toEqual({
        createdAt,
        exitCode: null,
        pid: Deno.pid,
        state: "waiting",
        step: null,
        stepCompletedAt: null,
        updatedAt: createdAt,
      });
      time.tick(1000);
      await status.runStep("lint", async () => {
        expect(await record()).toEqual({
          createdAt,
          exitCode: null,
          pid: Deno.pid,
          state: "running",
          step: "lint",
          stepCompletedAt: null,
          updatedAt: new Date().toISOString(),
        });
        const active = await record();
        time.tick(1000);
        expect(await record()).toEqual(active);
        return true;
      });
      expect((await record()).stepCompletedAt).toBe(new Date().toISOString());
      expect((await record()).updatedAt).toBe(new Date().toISOString());
      time.tick(1000);
      await status.runStep("typecheck", async () => {
        expect((await record()).stepCompletedAt).toBeNull();
        expect((await record()).step).toBe("typecheck");
        return true;
      });
      time.tick(1000);
      return 0;
    }, directory);
    expect(result).toBe(0);
    expect(await record()).toEqual({
      createdAt,
      exitCode: 0,
      pid: Deno.pid,
      state: "passed",
      step: "typecheck",
      stepCompletedAt: "2026-09-10T10:00:03.000Z",
      updatedAt: new Date().toISOString(),
    });
  });

  test("retains a failed step completion before the final exit code", async () => {
    const exitCode = await runWithPrecommitStatus(async (status) => {
      expect(await status.runStep("lint", () => Promise.resolve(false))).toBe(
        false,
      );
      expect((await record()).stepCompletedAt).not.toBeNull();
      return 3;
    }, directory);
    expect(exitCode).toBe(3);
    expect((await record()).state).toBe("failed");
    expect((await record()).exitCode).toBe(3);
  });

  test("records thrown failures without the error text or a false completion", async () => {
    const error = new Error("SECRET command args logs");
    await expect(
      runWithPrecommitStatus(async (status) => {
        await status.runStep("lint", () => Promise.reject(error));
        return 0;
      }, directory),
    ).rejects.toBe(error);
    const failed = await record();
    expect(failed.state).toBe("failed");
    expect(failed.exitCode).toBe(1);
    expect(failed.stepCompletedAt).toBeNull();
    expect(JSON.stringify(failed)).not.toContain("SECRET");
  });

  test("records a failure before a step starts", async () => {
    const error = new Error("Lock failed");
    await expect(
      runWithPrecommitStatus(() => Promise.reject(error), directory),
    ).rejects.toBe(error);
    expect((await record()).state).toBe("failed");
    expect((await record()).step).toBeNull();
  });

  test("rejects an unknown label before the action or any private write", async () => {
    let called = false;
    await expect(
      runWithPrecommitStatus(async (status) => {
        await status.runStep("SECRET command", () => {
          called = true;
          return Promise.resolve(true);
        });
        return 0;
      }, directory),
    ).rejects.toThrow();
    expect(called).toBe(false);
    expect((await record()).state).toBe("failed");
    expect((await record()).step).toBeNull();
    expect(JSON.stringify(await record())).not.toContain("SECRET");
  });

  test("retains completed checks when the push fails", async () => {
    const error = new Error("Push failed");
    await expect(
      runWithPrecommitStatus(async (status) => {
        await runChecksBeforePush(
          true,
          async () => {
            await status.runStep("lint", () => Promise.resolve(true));
          },
          () => Promise.reject(error),
          () => Promise.reject(new Error("CI must not acquire the lock")),
        );
        return 0;
      }, directory),
    ).rejects.toBe(error);
    expect((await record()).state).toBe("failed");
    expect((await record()).step).toBe("lint");
    expect((await record()).stepCompletedAt).not.toBeNull();
  });

  test("keeps separate queued records while the real lock serialises checks", async () => {
    const lock = precommitLockAt(join(directory, "checks.lock"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    let pushes = 0;
    const run = (first: boolean): Promise<number> =>
      runWithPrecommitStatus(async (status) => {
        if (!first) queued.resolve();
        await runChecksBeforePush(
          false,
          async () => {
            await status.runStep("lint", async () => {
              if (first) {
                entered.resolve();
                await release.promise;
              }
              return true;
            });
          },
          async () => {
            pushes += 1;
          },
          lock,
        );
        return 0;
      }, directory);
    const first = run(true);
    await entered.promise;
    const second = run(false);
    await queued.promise;
    try {
      expect((await records()).map((item) => item.state).sort()).toEqual([
        "running",
        "waiting",
      ]);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    expect((await records()).map((item) => item.state)).toEqual([
      "passed",
      "passed",
    ]);
    expect(pushes).toBe(2);
  });

  test("replaces complete JSON atomically and removes temporary files", async () => {
    const rename = Deno.rename;
    const previous: Array<string | null> = [];
    using _rename = stub(Deno, "rename", async (oldPath, newPath) => {
      const next = v.parse(
        PrecommitStatusSchema,
        JSON.parse(await Deno.readTextFile(oldPath)),
      );
      expect(String(oldPath)).not.toBe(String(newPath));
      const existing = await records();
      previous.push(existing[0]?.state ?? null);
      await rename(oldPath, newPath);
      expect(await record()).toEqual(next);
    });
    await runWithPrecommitStatus(async (status) => {
      await status.runStep("lint", () => Promise.resolve(true));
      return 0;
    }, directory);
    expect(previous).toEqual([null, "waiting", "running", "running"]);
    const entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry.name);
    expect(entries).toHaveLength(1);
  });

  test("surfaces atomic write failures without a partial record", async () => {
    const error = new Error("Disk failure");
    using _rename = stub(Deno, "rename", () => Promise.reject(error));
    await expect(
      runWithPrecommitStatus(() => Promise.resolve(0), directory),
    ).rejects.toBe(error);
    const entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry.name);
    expect(entries).toEqual([]);
  });
});
