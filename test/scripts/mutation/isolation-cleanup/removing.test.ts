import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { removeFinishedRuns } from "#scripts/mutation/isolation-cleanup.ts";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  markFinished,
  markRunning,
  newRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  LONG_AGO,
  removeRunClaim,
  runIdNamed,
  withTempDir,
  writeRunClaim,
} from "#test/scripts/mutation/isolation-helpers.ts";

describe("deleting the runs that are finished with", () => {
  test("keeps a run that came to life after its record was read", async () => {
    await withTempDir(async (root) => {
      // What a sweep read earlier: an old copying run. On disk now: the same
      // run, running under a fresh claim.
      const asRead = newRunRecord(
        runIdNamed("woke-up"),
        [],
        root,
        LONG_AGO.toISOString(),
      );
      await writeRunRecord(markRunning(asRead, Deno.pid));
      await writeRunClaim(asRead);

      expect((await removeFinishedRuns([asRead])).skipped).toEqual([asRead]);
    });
  });

  test("keeps a run whose child has gone while its supervisor holds on", async () => {
    await withTempDir(async (root) => {
      // The child's process id is dead and the record was written long ago —
      // the moment between a child ending and its supervisor settling the
      // record. The supervisor's claim is what says the run is still someone's.
      const settling = markRunning(
        newRunRecord(runIdNamed("settling"), [], root, LONG_AGO.toISOString()),
        99_999_999,
        LONG_AGO.toISOString(),
      );
      await writeRunRecord(settling);
      await writeRunClaim(settling);

      expect((await removeFinishedRuns([settling])).skipped).toEqual([
        settling,
      ]);
    });
  });

  test("keeps a finished run until its supervisor lets the claim go", async () => {
    await withTempDir(async (root) => {
      // A supervisor clearing its snapshot away holds the claim after its
      // child has gone, so the record can already read as finished.
      const finished = markFinished(
        newRunRecord(runIdNamed("settled"), [], root, LONG_AGO.toISOString()),
        0,
      );
      await writeRunRecord(finished);
      await writeRunClaim(finished);

      expect((await removeFinishedRuns([finished])).skipped).toEqual([
        finished,
      ]);

      await removeRunClaim(finished);
      expect((await removeFinishedRuns([finished])).removed).toEqual([
        finished,
      ]);
    });
  });
});
