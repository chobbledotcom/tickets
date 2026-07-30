import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bringFilesBack,
  readCopyBackFiles,
} from "#scripts/mutation/snapshot-copy-back.ts";
import { captureConsole } from "#test/scripts/mutation/isolation-helpers.ts";
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

/** Note what the kept file holds, run `between`, then bring the file back. */
const keepFile = async (
  roots: { root: string; workRoot: string },
  between: () => Promise<void> = () => Promise.resolve(),
): ReturnType<typeof captureConsole<number>> => {
  const files = await readCopyBackFiles(roots.root, [KEPT]);
  await between();
  return await captureConsole(() =>
    bringFilesBack(roots.root, roots.workRoot, files),
  );
};

describe("bringing files back out of a snapshot", () => {
  test("copies a file the run changed into the checkout", async () => {
    await withCheckoutAndCopy("one\ntwo\n", "one\n", async (roots) => {
      const run = await keepFile(roots);

      expect(run.result).toBe(0);
      expect(run.logs).toEqual([`Updated ${KEPT}`]);
      expect(await Deno.readTextFile(join(roots.root, KEPT))).toBe("one\n");
    });
  });

  test("leaves a file the run did not change alone", async () => {
    await withCheckoutAndCopy("same\n", "same\n", async (roots) => {
      const before = await Deno.stat(join(roots.root, KEPT));

      const run = await keepFile(roots);

      expect(run.result).toBe(0);
      expect(run.logs).toEqual([]);
      expect((await Deno.stat(join(roots.root, KEPT))).mtime).toEqual(
        before.mtime,
      );
    });
  });

  test("refuses to overwrite an edit made while the run was going", async () => {
    await withCheckoutAndCopy("one\ntwo\n", "one\n", async (roots) => {
      const run = await keepFile(roots, () =>
        Deno.writeTextFile(join(roots.root, KEPT), "one\ntwo\nthree\n"),
      );

      expect(run.result).toBe(1);
      expect(run.errors.join("\n")).toContain(
        `${KEPT} changed while the isolated run was going`,
      );
      expect(await Deno.readTextFile(join(roots.root, KEPT))).toBe(
        "one\ntwo\nthree\n",
      );
    });
  });

  test("writes no file when a later one changed during the run", async () => {
    await withCheckoutAndCopy("one\ntwo\n", "one\n", async (roots) => {
      // A second kept file, edited in the checkout mid-run. Every check runs
      // before any write, so the first file must stay untouched too.
      const second = "second.txt";
      await Deno.writeTextFile(join(roots.root, second), "a\n");
      await Deno.writeTextFile(join(roots.workRoot, second), "b\n");
      const files = await readCopyBackFiles(roots.root, [KEPT, second]);
      await Deno.writeTextFile(join(roots.root, second), "edited\n");

      const run = await captureConsole(() =>
        bringFilesBack(roots.root, roots.workRoot, files),
      );

      expect(run.result).toBe(1);
      expect(run.errors.join("\n")).toContain(
        `${second} changed while the isolated run was going`,
      );
      expect(await Deno.readTextFile(join(roots.root, KEPT))).toBe(
        "one\ntwo\n",
      );
    });
  });

  test("reads nothing when no files are kept", async () => {
    await withCheckoutAndCopy("one\n", "one\n", async (roots) => {
      expect(await readCopyBackFiles(roots.root, [])).toEqual([]);
    });
  });
});
