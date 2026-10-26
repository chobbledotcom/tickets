import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  ISOLATION_USAGE,
  type MutationRunRecord,
  markChildEnded,
  markFinished,
  markRunning,
  newRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  captureMutationCommand,
  finishedRun,
  runIdNamed,
  runningRun,
  runningRunApart,
  runningWithoutPid,
  runQuietMutationCommand,
  withTempDir,
  writeRunClaim,
} from "#test/scripts/mutation/isolation-helpers.ts";
import {
  finishedChild,
  type KillCall,
  recordKillCalls,
  stubCommand,
  writeRecords,
} from "./helpers.ts";

describe("listing, signalling and cleaning isolated runs", () => {
  /** Write a run's record and its fresh claim, then run a kill command over
   * it while every signal sent is recorded instead of delivered. */
  const killRecordedRun = async (
    root: string,
    record: MutationRunRecord,
    ...extraArgs: string[]
  ): Promise<{ calls: KillCall[]; result: number }> => {
    await writeRunRecord(record);
    await writeRunClaim(record);
    const calls: KillCall[] = [];
    using _kill = recordKillCalls(calls);
    const result = await runQuietMutationCommand(
      ["--kill", record.id, ...extraArgs],
      root,
    );
    return { calls, result };
  };

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

  test("lists running runs only while their claim is fresh", async () => {
    await withTempDir(async (root) => {
      // A live pid is not enough: with nobody's claim on the folder, the
      // supervisor is gone and the run reads as stale.
      const unclaimed = markRunning(
        newRunRecord(
          runIdNamed("unclaimed"),
          [],
          root,
          "2026-07-09T12:04:00.000Z",
        ),
        { pid: Deno.pid, supervisorPid: Deno.pid },
      );
      const live = markRunning(
        newRunRecord(
          runIdNamed("live"),
          ["src/live.ts"],
          root,
          "2026-07-09T12:03:00.000Z",
        ),
        { pid: Deno.pid, supervisorPid: Deno.pid },
      );
      const stale = markRunning(
        newRunRecord(runIdNamed("stale"), [], root, "2026-07-09T12:02:00.000Z"),
        { pid: 99_999_999, supervisorPid: 99_999_999 },
      );
      const copying = newRunRecord(
        runIdNamed("copying"),
        [],
        root,
        "2026-07-09T12:01:00.000Z",
      );
      await writeRecords([unclaimed, live, stale, copying]);
      await writeRunClaim(live);

      const list = await captureMutationCommand(["list"], root);

      expect(list).toEqual({
        errors: [],
        logs: [
          `${runIdNamed("unclaimed")} stale pid=${Deno.pid} exit=- work=.mutation-runs/${runIdNamed("unclaimed")}/work`,
          `${runIdNamed("live")} running pid=${Deno.pid} exit=- work=.mutation-runs/${runIdNamed("live")}/work args=src/live.ts`,
          `${runIdNamed("stale")} stale pid=99999999 exit=- work=.mutation-runs/${runIdNamed("stale")}/work`,
          `${runIdNamed("copying")} copying pid=- exit=- work=.mutation-runs/${runIdNamed("copying")}/work`,
        ],
        result: 0,
      });
    });
  });

  test("lists stale records without shelling anything out", async () => {
    await withTempDir(async (root) => {
      const stale = runningRun("stale", root, 99_999_999);
      await writeRunRecord(stale);

      const starts: Deno.CommandOptions[] = [];
      using _command = stubCommand(finishedChild(42_428), starts);

      const list = await captureMutationCommand(["--list"], root);

      // Staleness is read straight from the claim file, nothing shelled out.
      expect(starts).toEqual([]);
      expect(list).toEqual({
        errors: [],
        logs: [
          `${runIdNamed("stale")} stale pid=99999999 exit=- work=.mutation-runs/${runIdNamed("stale")}/work`,
        ],
        result: 0,
      });
    });
  });

  test("signals claimed runs and reports missing or stale targets", async () => {
    await withTempDir(async (root) => {
      const live = runningRun("live", root, Deno.pid);
      const noPid = runningWithoutPid("nopid", root);
      const passed = finishedRun("passed", root);
      // Finished, but its pids are this very process, so they are certainly
      // alive: only the status should keep it from being signalled.
      const done = markFinished(
        markRunning(newRunRecord(runIdNamed("done"), [], root), {
          pid: Deno.pid,
          supervisorPid: Deno.pid,
        }),
        0,
      );
      await writeRecords([live, noPid, passed, done]);
      await writeRunClaim(live);
      await writeRunClaim(noPid);
      await writeRunClaim(done);

      const calls: KillCall[] = [];
      using _kill = recordKillCalls(calls);

      expect(
        await runQuietMutationCommand(["--kill", runIdNamed("live")], root),
      ).toBe(0);
      expect(
        await runQuietMutationCommand(
          ["kill", runIdNamed("live"), "--force"],
          root,
        ),
      ).toBe(0);

      expect(calls).toEqual([
        { pid: Deno.pid, signal: "SIGTERM" },
        { pid: Deno.pid, signal: "SIGKILL" },
      ]);
      expect(await runQuietMutationCommand(["--kill", "missing"], root)).toBe(
        1,
      );
      expect(
        await runQuietMutationCommand(["--kill", runIdNamed("passed")], root),
      ).toBe(1);
      expect(
        await runQuietMutationCommand(["--kill", runIdNamed("nopid")], root),
      ).toBe(1);
      expect(
        await runQuietMutationCommand(["--kill", runIdNamed("done")], root),
      ).toBe(1);
      // Still only the two signals sent to the live run above.
      expect(calls).toHaveLength(2);
    });
  });

  test("signals a run's supervisor, never the child pid beside it", async () => {
    await withTempDir(async (root) => {
      // The record as a kill between the child's exit and the record write
      // finds it: the child's pid is still in it — and live, since the system
      // may have handed that id to a stranger — while only the supervisor is
      // left of the run. Signalling the child's pid would be a guess about
      // somebody else's process, so only the supervisor may be signalled.
      const racing = runningRunApart("racing", root, {
        pid: Deno.ppid,
        supervisorPid: Deno.pid,
      });

      const polite = await killRecordedRun(root, racing);
      const forced = await killRecordedRun(root, racing, "--force");

      expect(polite.result).toBe(0);
      expect(forced.result).toBe(0);
      expect([...polite.calls, ...forced.calls]).toEqual([
        { pid: Deno.pid, signal: "SIGTERM" },
        { pid: Deno.pid, signal: "SIGKILL" },
      ]);
    });
  });

  test("still signals a run whose child has ended, through its supervisor", async () => {
    await withTempDir(async (root) => {
      // The record once the child's status resolved: its pid has already
      // left it, and the supervisor is bringing the run's kept files back.
      // The kill must still reach the run, through the supervisor.
      const windingDown = markChildEnded(
        runningRunApart("winding-down", root, {
          pid: Deno.ppid,
          supervisorPid: Deno.pid,
        }),
      );

      const { calls, result } = await killRecordedRun(root, windingDown);

      expect(result).toBe(0);
      expect(calls).toEqual([{ pid: Deno.pid, signal: "SIGTERM" }]);
    });
  });

  test("never signals a pid its run's supervisor has walked away from", async () => {
    await withTempDir(async (root) => {
      // The record's pid is alive, but it may have been handed to an
      // unrelated program after the supervisor died: with no fresh claim to
      // vouch for the run, nothing may be signalled.
      const orphaned = runningRun("orphaned", root, Deno.pid);
      await writeRunRecord(orphaned);

      const calls: KillCall[] = [];
      using _kill = recordKillCalls(calls);

      expect(
        await runQuietMutationCommand(["--kill", runIdNamed("orphaned")], root),
      ).toBe(1);
      expect(calls).toEqual([]);
    });
  });

  test("reports claimed runs that cannot be signalled", async () => {
    await withTempDir(async (root) => {
      const live = runningRun("live", root, Deno.pid);
      await writeRunRecord(live);
      await writeRunClaim(live);

      using _kill = stub(Deno, "kill", (() => {
        throw new Error("cannot signal");
      }) as typeof Deno.kill);

      expect(
        await runQuietMutationCommand(["--kill", runIdNamed("live")], root),
      ).toBe(1);
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
