import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { writeRunRecord } from "#scripts/mutation/isolation-records.ts";
import {
  createRunId,
  MUTATION_CLAIM_FILE,
  MUTATION_RECORD_FILE,
  markFinished,
  newRunRecord,
  runRoot,
  runsRoot,
} from "#scripts/mutation/isolation-state.ts";
import { captureSimpleSnapshotMutation } from "#test/scripts/mutation/isolation/helpers.ts";
import {
  LONG_AGO,
  withTempDir,
  writeFakeMutationScript,
  writeRunClaim,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";

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
const writeUnreadableRun = async (root: string): Promise<string> => {
  const folder = runRoot(BROKEN_RUN_ID, root);
  await Deno.mkdir(join(folder, "work"), { recursive: true });
  await Deno.writeTextFile(join(folder, MUTATION_RECORD_FILE), "{ half");
  return folder;
};

const runAfterUnreadableRun = async (root: string): Promise<string> => {
  await writeFakeMutationScript(root, "Deno.exit(0);\n");
  const folder = await writeUnreadableRun(root);
  await captureSimpleSnapshotMutation(root);
  return folder;
};

describe("clearing up before a mutation run", () => {
  test("clears out a run folder whose record cannot be read", async () => {
    await withTempDir(async (root) => {
      const folder = await runAfterUnreadableRun(root);

      expect(await pathExists(folder)).toBe(false);
    });
  });

  test("leaves an unreadable run folder alone while its claim is fresh", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const folder = await writeUnreadableRun(root);
      // Another run may be writing this record right now: its supervisor's
      // claim, taken before the record's first write, is what says so.
      await writeRunClaim({ root: folder });

      await captureSimpleSnapshotMutation(root);

      expect(await pathExists(folder)).toBe(true);
    });
  });

  test("gives up when a run's claim cannot be asked about at all", async () => {
    await withTempDir(async (root) => {
      await writeFakeMutationScript(root, "Deno.exit(0);\n");
      const folder = await writeUnreadableRun(root);
      await writeRunClaim({ root: folder });

      const readTextFile = Deno.readTextFile;
      using _read = stub(Deno, "readTextFile", ((
        path: string | URL,
        options?: Deno.ReadFileOptions,
      ) => {
        if (`${path}` === join(folder, MUTATION_CLAIM_FILE)) {
          // Anything other than a missing claim means the disk is in a state
          // we must not guess about, so the run stops instead of deleting blind.
          return Promise.reject(new Deno.errors.PermissionDenied("no access"));
        }
        return readTextFile(path, options);
      }) as typeof Deno.readTextFile);

      await expect(captureSimpleSnapshotMutation(root)).rejects.toThrow(
        "no access",
      );
      expect(await pathExists(folder)).toBe(true);
    });
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
