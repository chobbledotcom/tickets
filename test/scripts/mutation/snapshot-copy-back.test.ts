import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  copyBackFiles,
  readCopyBackFiles,
} from "#scripts/mutation/snapshot-copy-back.ts";
import { withTempDir } from "#test-utils/files.ts";

const KEPT = "kept.txt";

/** A checkout holding `live`, and a copy of it holding `inWork`. */
const withCheckoutAndCopy = <Result>(
  live: string,
  inWork: string,
  run: (roots: { root: string; workRoot: string }) => Promise<Result>,
): Promise<Result> =>
  withTempDir(
    async (dir) => {
      const root = join(dir, "checkout");
      const workRoot = join(dir, "work");
      await Deno.mkdir(root);
      await Deno.mkdir(workRoot);
      await Deno.writeTextFile(join(root, KEPT), live);
      await Deno.writeTextFile(join(workRoot, KEPT), inWork);
      return await run({ root, workRoot });
    },
    { prefix: "snapshot-copy-back-" },
  );

describe("bringing files back out of a snapshot", () => {
  test("copies a file the run changed into the checkout", async () => {
    await withCheckoutAndCopy("one\ntwo\n", "one\n", async (roots) => {
      const files = await readCopyBackFiles(roots.root, [KEPT]);

      const copied = await copyBackFiles(roots.root, roots.workRoot, files);

      expect(copied).toEqual([KEPT]);
      expect(await Deno.readTextFile(join(roots.root, KEPT))).toBe("one\n");
    });
  });

  test("leaves a file the run did not change alone", async () => {
    await withCheckoutAndCopy("same\n", "same\n", async (roots) => {
      const files = await readCopyBackFiles(roots.root, [KEPT]);
      const before = await Deno.stat(join(roots.root, KEPT));

      const copied = await copyBackFiles(roots.root, roots.workRoot, files);

      expect(copied).toEqual([]);
      expect((await Deno.stat(join(roots.root, KEPT))).mtime).toEqual(
        before.mtime,
      );
    });
  });

  test("refuses to overwrite an edit made while the run was going", async () => {
    await withCheckoutAndCopy("one\ntwo\n", "one\n", async (roots) => {
      const files = await readCopyBackFiles(roots.root, [KEPT]);
      await Deno.writeTextFile(join(roots.root, KEPT), "one\ntwo\nthree\n");

      await expect(
        copyBackFiles(roots.root, roots.workRoot, files),
      ).rejects.toThrow(`${KEPT} changed while the isolated run was going`);
      expect(await Deno.readTextFile(join(roots.root, KEPT))).toBe(
        "one\ntwo\nthree\n",
      );
    });
  });

  test("reads nothing when no files are kept", async () => {
    await withCheckoutAndCopy("one\n", "one\n", async (roots) => {
      expect(await readCopyBackFiles(roots.root, [])).toEqual([]);
    });
  });
});
