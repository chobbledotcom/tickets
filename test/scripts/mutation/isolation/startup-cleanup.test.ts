import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  createRunId,
  MUTATION_RECORD_FILE,
  markFinished,
  newRunRecord,
  runRoot,
  runsRoot,
} from "#scripts/mutation/isolation-state.ts";
import {
  LONG_AGO,
  withTempDir,
  writeFakeMutationScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";
import { captureSimpleSnapshotMutation } from "./helpers.ts";

/** Shaped like a real run id, so the sweep counts the folder as one of ours. */
const BROKEN_RUN_ID = createRunId(
  new Date("2026-01-01T00:00:00.000Z"),
  "0badc0de",
);

const OLD_RUN_ID = createRunId(
  new Date("2026-01-02T00:00:00.000Z"),
  "0dd0c0de",
);

/** A run folder holding a snapshot and a record too broken to read. */
const writeUnreadableRun = async (
  root: string,
  changedAt: Date,
): Promise<string> => {
  const folder = runRoot(BROKEN_RUN_ID, root);
  await Deno.mkdir(join(folder, "work"), { recursive: true });
  await Deno.writeTextFile(join(folder, MUTATION_RECORD_FILE), "{ half");
  await Deno.utime(folder, changedAt, changedAt);
  return folder;
};

/** Answer stats about the broken run folder with `info`, and pass the rest on. */
const stubRunsFolderStat = (
  info: Partial<Deno.FileInfo> | Error,
): Disposable => {
  const stat = Deno.stat;
  return stub(Deno, "stat", ((path: string | URL) => {
    if (!`${path}`.includes(BROKEN_RUN_ID)) return stat(path);
    return info instanceof Error
      ? Promise.reject(info)
      : Promise.resolve(info as Deno.FileInfo);
  }) as typeof Deno.stat);
};

const runAfterUnreadableRun = async (
  root: string,
  changedAt: Date,
): Promise<string> => {
  await writeFakeMutationScript(root, "Deno.exit(0);\n");
  const folder = await writeUnreadableRun(root, changedAt);
  await captureSimpleSnapshotMutation(root);
  return folder;
};

/**
 * Run with a just-made unreadable run folder that answers stats with `info`,
 * and report whether the folder was still there afterwards.
 */
const runWithStatAnswer = (
  info: Partial<Deno.FileInfo> | Error,
): Promise<boolean> =>
  withTempDir(async (root) => {
    await writeFakeMutationScript(root, "Deno.exit(0);\n");
    const folder = await writeUnreadableRun(root, new Date());

    await (async () => {
      using _stat = stubRunsFolderStat(info);
      await captureSimpleSnapshotMutation(root);
    })();

    return await pathExists(folder);
  });

describe("clearing up before a mutation run", () => {
  test("clears out a run folder whose record cannot be read", async () => {
    await withTempDir(async (root) => {
      const folder = await runAfterUnreadableRun(root, LONG_AGO);

      expect(await pathExists(folder)).toBe(false);
    });
  });

  test("leaves a run folder alone while its record is being written", async () => {
    await withTempDir(async (root) => {
      const folder = await runAfterUnreadableRun(root, new Date());

      // Another run may be writing this record right now.
      expect(await pathExists(folder)).toBe(true);
    });
  });

  test("leaves alone a run folder whose age cannot be told", async () => {
    // No way to know it is over, so it stays put rather than being deleted.
    expect(await runWithStatAnswer({ isDirectory: true, mtime: null })).toBe(
      true,
    );
    expect(await runWithStatAnswer(new Deno.errors.NotFound("gone"))).toBe(
      true,
    );
  });

  test("gives up when a run folder cannot be asked about at all", async () => {
    // Anything other than a missing folder means the disk is in a state we
    // must not guess about, so the run stops instead of deleting blind.
    await expect(
      runWithStatAnswer(new Deno.errors.PermissionDenied("no access")),
    ).rejects.toThrow("no access");
  });

  test("leaves alone a folder this runner did not name", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const theirs = join(runsRoot(root), "someone-elses-work");
      await Deno.mkdir(theirs, { recursive: true });
      await Deno.writeTextFile(join(theirs, "notes.txt"), "keep me");
      await Deno.utime(theirs, LONG_AGO, LONG_AGO);

      await captureSimpleSnapshotMutation(root);

      expect(await pathExists(join(theirs, "notes.txt"))).toBe(true);
    });
  });

  test("reports an earlier run it cannot clear out", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const old = markFinished(
        newRunRecord(OLD_RUN_ID, [], root, LONG_AGO.toISOString()),
        0,
      );
      await writeRunRecord(old);

      const remove = Deno.remove;
      const run = await (async () => {
        using _remove = stub(Deno, "remove", ((
          path: string | URL,
          options?: Deno.RemoveOptions,
        ) => {
          if (`${path}` === old.root) {
            return Promise.reject(new Error("permission denied"));
          }
          return remove(path, options);
        }) as typeof Deno.remove);
        return await captureSimpleSnapshotMutation(root);
      })();

      expect(run.errors).toEqual([
        `Failed to remove the earlier run ${OLD_RUN_ID}: permission denied`,
      ]);
      expect(await pathExists(join(runsRoot(root), OLD_RUN_ID))).toBe(true);
    });
  });
});
