import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  liveRunIdSet,
  runIsOwned,
} from "#scripts/mutation/isolation-cleanup.ts";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import { markFinished } from "#scripts/mutation/isolation-state.ts";
import {
  runningRunApart,
  runningWithoutPid,
  withTempDir,
  writeRunClaim,
} from "#test/scripts/mutation/isolation-helpers.ts";

describe("which runs still have somebody to signal", () => {
  test("owns a running run whose supervisor is recorded and claim is fresh", async () => {
    await withTempDir(async (root) => {
      // The child has already ended, so only the supervisor's pid is left to
      // go on — and it is the one a kill must reach.
      const live = runningRunApart("live", root, {
        pid: Deno.ppid,
        supervisorPid: Deno.pid,
      });
      await writeRunClaim(live);

      expect(await runIsOwned(live)).toBe(true);
      expect(await liveRunIdSet([live])).toEqual(new Set([live.id]));
    });
  });

  test("owns nothing for a running run whose supervisor pid is missing", async () => {
    await withTempDir(async (root) => {
      // A record from before the run started its child: nobody is signalable.
      const unrecorded = runningWithoutPid("unrecorded", root);
      await writeRunRecord(unrecorded);
      await writeRunClaim(unrecorded);

      expect(await runIsOwned(unrecorded)).toBe(false);
      expect(await liveRunIdSet([unrecorded])).toEqual(new Set());
    });
  });

  test("owns nothing for a run whose status is over", async () => {
    await withTempDir(async (root) => {
      // A finished run whose pids are still this very process and whose claim
      // is still fresh: only the status may keep it from being signalled.
      const done = markFinished(
        runningRunApart("done", root, {
          pid: Deno.pid,
          supervisorPid: Deno.pid,
        }),
        0,
      );
      await writeRunClaim(done);

      expect(await runIsOwned(done)).toBe(false);
      expect(await liveRunIdSet([done])).toEqual(new Set());
    });
  });

  test("owns nothing for a run whose claim has gone", async () => {
    await withTempDir(async (root) => {
      const walkedAway = runningRunApart("walked-away", root, {
        pid: Deno.ppid,
        supervisorPid: Deno.pid,
      });
      await writeRunRecord(walkedAway);

      expect(await runIsOwned(walkedAway)).toBe(false);
      expect(await liveRunIdSet([walkedAway])).toEqual(new Set());
    });
  });
});
