import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  MUTATION_RECORD_FILE,
  markFinished,
  newRunRecord,
  runRoot,
  runsRoot,
  writeRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  withTempDir,
  writeFakeMutationScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import {
  pathExists,
  withTempDir as withSharedTempDir,
} from "#test-utils/files.ts";
import { captureSimpleSnapshotMutation } from "./helpers.ts";

const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

/** A run folder holding a snapshot and a record too broken to read. */
const writeUnreadableRun = async (
  root: string,
  changedAt: Date,
): Promise<string> => {
  const folder = runRoot("mutation-broken", root);
  await Deno.mkdir(join(folder, "work"), { recursive: true });
  await Deno.writeTextFile(join(folder, MUTATION_RECORD_FILE), "{ half");
  await Deno.utime(folder, changedAt, changedAt);
  return folder;
};

/** Answer every stat about the runs folder with `info`, and pass the rest on. */
const stubRunsFolderStat = (
  info: Partial<Deno.FileInfo> | Error,
): Disposable => {
  const stat = Deno.stat;
  return stub(Deno, "stat", ((path: string | URL) => {
    if (!`${path}`.includes("mutation-broken")) return stat(path);
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
  withSharedTempDir(async (root) => {
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

  test("clears out a run folder it cannot ask about", async () => {
    expect(await runWithStatAnswer(new Deno.errors.NotFound("gone"))).toBe(
      false,
    );
  });

  test("clears out a run folder with no change time", async () => {
    expect(await runWithStatAnswer({ isDirectory: true, mtime: null })).toBe(
      false,
    );
  });

  test("gives up when a run folder cannot be asked about at all", async () => {
    // Anything other than a missing folder means the disk is in a state we
    // must not guess about, so the run stops instead of deleting blind.
    await expect(
      runWithStatAnswer(new Deno.errors.PermissionDenied("no access")),
    ).rejects.toThrow("no access");
  });

  test("reports an earlier run it cannot clear out", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const old = markFinished(
        newRunRecord("mutation-old", [], root, LONG_AGO.toISOString()),
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
        "Failed to remove the earlier run mutation-old: permission denied",
      ]);
      expect(await pathExists(join(runsRoot(root), "mutation-old"))).toBe(true);
    });
  });
});
