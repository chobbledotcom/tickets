import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { withMutationRunLock } from "#scripts/mutation/isolation-lock.ts";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  ISOLATION_USAGE,
  markFinished,
  markRunning,
  newRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  captureMutationCommand,
  runQuietMutationCommand,
  withTempDir,
} from "#test/scripts/mutation/isolation-helpers.ts";
import {
  finishedChild,
  type KillCall,
  stubCommand,
  writeRecords,
} from "./helpers.ts";

describe("listing, signalling and cleaning isolated runs", () => {
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

      const starts: Deno.CommandOptions[] = [];
      using _command = stubCommand(finishedChild(42_428), starts);

      const list = await captureMutationCommand(["--list"], root);

      // A stale pid is judged from the record alone, with nothing shelled out.
      expect(starts).toEqual([]);
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
      // Finished, but its pid is this very process, so the pid is certainly
      // alive: only the status should keep it from being signalled.
      const done = markFinished(
        markRunning(newRunRecord("mutation-done", [], root), Deno.pid),
        0,
      );
      await writeRecords([live, noPid, passed, done]);

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
      expect(
        await runQuietMutationCommand(["--kill", "mutation-done"], root),
      ).toBe(1);
      // Still only the two signals sent to the live run above.
      expect(calls).toHaveLength(2);
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
