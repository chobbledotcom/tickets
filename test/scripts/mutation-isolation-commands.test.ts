import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { withMutationRunLock } from "../../scripts/mutation/isolation-lock.ts";
import {
  ISOLATION_USAGE,
  type MutationRunRecord,
  markFinished,
  markRunning,
  newRunRecord,
  writeRunRecord,
} from "../../scripts/mutation/isolation-state.ts";
import {
  captureMutationCommand,
  denoCommand,
  runQuietMutationCommand,
  withTempDir,
} from "./mutation-isolation-helpers.ts";

type KillCall = { pid: number; signal: Deno.Signal | undefined };

const writeRecords = async (records: MutationRunRecord[]): Promise<void> => {
  await Promise.all(records.map(writeRunRecord));
};

describe("mutation isolation supervisor commands", () => {
  test("runs invalid, help, and empty list commands", async () => {
    await withTempDir(async (root) => {
      const invalid = await captureMutationCommand([], root);
      expect(invalid.result).toBe(1);
      expect(invalid.errors[0]).toBe(
        "Mutation source and test globs are required.",
      );
      expect(invalid.errors[1]).toBe(ISOLATION_USAGE);

      const help = await captureMutationCommand(["--help"], root);
      expect(help).toEqual({ errors: [], logs: [ISOLATION_USAGE], result: 0 });

      const list = await captureMutationCommand(["--list"], root);
      expect(list).toEqual({
        errors: [],
        logs: ["No isolated mutation runs."],
        result: 0,
      });
    });
  });

  test("lists running runs only when their pid and lock are live", async () => {
    await withTempDir(async (root) => {
      const unlocked = markRunning(
        newRunRecord("mutation-unlocked", [], root, "2026-07-09T12:04:00.000Z"),
        Deno.pid,
      );
      const live = markRunning(
        newRunRecord(
          "mutation-live",
          ["src/live.ts"],
          root,
          "2026-07-09T12:03:00.000Z",
        ),
        Deno.pid,
      );
      const stale = markRunning(
        newRunRecord("mutation-stale", [], root, "2026-07-09T12:02:00.000Z"),
        99_999_999,
      );
      const copying = newRunRecord(
        "mutation-copying",
        [],
        root,
        "2026-07-09T12:01:00.000Z",
      );
      await writeRecords([unlocked, live, stale, copying]);

      await withMutationRunLock(live.root, async () => {
        const list = await captureMutationCommand(["list"], root);

        expect(list).toEqual({
          errors: [],
          logs: [
            `mutation-unlocked stale pid=${Deno.pid} exit=- work=.mutation-runs/mutation-unlocked/work`,
            `mutation-live running pid=${Deno.pid} exit=- work=.mutation-runs/mutation-live/work args=src/live.ts`,
            "mutation-stale stale pid=99999999 exit=- work=.mutation-runs/mutation-stale/work",
            "mutation-copying copying pid=- exit=- work=.mutation-runs/mutation-copying/work",
          ],
          result: 0,
        });
      });
    });
  });

  test("lists stale pid records without shelling out to kill", async () => {
    await withTempDir(async (root) => {
      const stale = markRunning(
        newRunRecord("mutation-stale", [], root),
        99_999_999,
      );
      await writeRunRecord(stale);

      using _command = stub(denoCommand, "Command", function failCommand() {
        throw new Error("unexpected external command");
      });

      const list = await captureMutationCommand(["--list"], root);

      expect(list).toEqual({
        errors: [],
        logs: [
          "mutation-stale stale pid=99999999 exit=- work=.mutation-runs/mutation-stale/work",
        ],
        result: 0,
      });
    });
  });

  test("signals live runs and reports missing or stale targets", async () => {
    await withTempDir(async (root) => {
      const live = markRunning(
        newRunRecord("mutation-live", [], root),
        Deno.pid,
      );
      const noPid = {
        ...newRunRecord("mutation-nopid", [], root),
        status: "running" as const,
      };
      const passed = markFinished(newRunRecord("mutation-passed", [], root), 0);
      await writeRecords([live, noPid, passed]);

      const calls: KillCall[] = [];
      using _kill = stub(Deno, "kill", ((pid, signal) => {
        calls.push({ pid, signal });
      }) as typeof Deno.kill);

      await withMutationRunLock(live.root, async () => {
        expect(
          await runQuietMutationCommand(["--kill", "mutation-live"], root),
        ).toBe(0);
        expect(
          await runQuietMutationCommand(
            ["kill", "mutation-live", "--force"],
            root,
          ),
        ).toBe(0);
      });

      expect(calls).toEqual([
        { pid: Deno.pid, signal: "SIGTERM" },
        { pid: Deno.pid, signal: "SIGTERM" },
        { pid: Deno.pid, signal: "SIGKILL" },
      ]);
      expect(await runQuietMutationCommand(["--kill", "missing"], root)).toBe(
        1,
      );
      expect(
        await runQuietMutationCommand(["--kill", "mutation-passed"], root),
      ).toBe(1);
      expect(
        await runQuietMutationCommand(["--kill", "mutation-nopid"], root),
      ).toBe(1);
    });
  });

  test("reports live runs that cannot be signalled", async () => {
    await withTempDir(async (root) => {
      const live = markRunning(
        newRunRecord("mutation-live", [], root),
        Deno.pid,
      );
      await writeRunRecord(live);

      using _kill = stub(Deno, "kill", (() => {
        throw new Error("cannot signal");
      }) as typeof Deno.kill);

      await withMutationRunLock(live.root, async () => {
        expect(
          await runQuietMutationCommand(["--kill", "mutation-live"], root),
        ).toBe(1);
      });
    });
  });

  test("force kill catches SIGKILL failure when the process exits during the grace window", async () => {
    await withTempDir(async (root) => {
      const live = markRunning(
        newRunRecord("mutation-live", [], root),
        Deno.pid,
      );
      await writeRunRecord(live);

      const calls: KillCall[] = [];
      using _kill = stub(Deno, "kill", ((pid, signal) => {
        calls.push({ pid, signal });
        if (signal === "SIGKILL") throw new Error("already gone");
      }) as typeof Deno.kill);

      await withMutationRunLock(live.root, async () => {
        expect(
          await runQuietMutationCommand(
            ["kill", "mutation-live", "--force"],
            root,
          ),
        ).toBe(0);
      });

      expect(calls.map((c) => c.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    });
  });

  test("reports missing clean targets", async () => {
    await withTempDir(async (root) => {
      const clean = await captureMutationCommand(["--clean", "missing"], root);

      expect(clean).toEqual({
        errors: ["No isolated mutation run matched missing."],
        logs: [],
        result: 1,
      });
    });
  });
});
