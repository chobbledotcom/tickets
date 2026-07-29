import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { removeFinishedRuns } from "#scripts/mutation/isolation-cleanup.ts";
import { withMutationRunLock } from "#scripts/mutation/isolation-lock.ts";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  markFinished,
  markRunning,
  newRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  LONG_AGO,
  runIdNamed,
  withTempDir,
} from "#test/scripts/mutation/isolation-helpers.ts";

describe("deleting the runs that are finished with", () => {
  test("keeps a run that came to life while the lock was probed", async () => {
    await withTempDir(async (root) => {
      // What a sweep read before waiting on the lock: an old copying run.
      const asRead = newRunRecord(
        runIdNamed("woke-up"),
        [],
        root,
        LONG_AGO.toISOString(),
      );
      // What is on disk now: the same run, started moments ago.
      await writeRunRecord(markRunning(asRead, Deno.pid));

      expect((await removeFinishedRuns([asRead])).skipped).toEqual([asRead]);
    });
  });

  test("keeps a finished run whose folder is still held", async () => {
    await withTempDir(async (root) => {
      // A supervisor writing its last record holds the lock after its child
      // has gone, so the record can already read as finished.
      const settling = markFinished(
        newRunRecord(runIdNamed("settling"), [], root, LONG_AGO.toISOString()),
        0,
      );
      await writeRunRecord(settling);

      await withMutationRunLock(settling.root, async () => {
        expect((await removeFinishedRuns([settling])).skipped).toEqual([
          settling,
        ]);
      });
      expect((await removeFinishedRuns([settling])).removed).toEqual([
        settling,
      ]);
    });
  });
});
