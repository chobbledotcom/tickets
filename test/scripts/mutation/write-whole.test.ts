import { join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { writeWholeOrNotAtAll } from "#scripts/mutation/write-whole.ts";
import { captureConsole } from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists, withTempDir } from "#test-utils/files.ts";

describe("writing a whole file", () => {
  test("replaces the file and leaves no temp file behind", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "listing.ts");
      await Deno.writeTextFile(file, "old\n");
      await writeWholeOrNotAtAll(file, "new\n");
      assertEquals(await Deno.readTextFile(file), "new\n");
      assertEquals(await pathExists(`${file}.writing`), false);
    });
  });

  test("removes the temp file when the write dies part-way", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "listing.ts");
      await Deno.writeTextFile(file, "old\n");
      const failure = new Error("no space left on device");
      await assertRejects(
        () =>
          writeWholeOrNotAtAll(file, "new\n", {
            remove: Deno.remove,
            rename: Deno.rename,
            // A full disk: some bytes land, then the write dies.
            writeTextFile: async (temp, text) => {
              await Deno.writeTextFile(temp, text.slice(0, 2));
              throw failure;
            },
          }),
        Error,
        "no space left on device",
      );
      assertEquals(await Deno.readTextFile(file), "old\n");
      assertEquals(await pathExists(`${file}.writing`), false);
    });
  });

  test("removes the temp file when the rename fails", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "listing.ts");
      await Deno.writeTextFile(file, "old\n");
      const failure = new Error("the target file is locked");
      await assertRejects(
        () =>
          writeWholeOrNotAtAll(file, "new\n", {
            remove: Deno.remove,
            rename: () => Promise.reject(failure),
            writeTextFile: Deno.writeTextFile,
          }),
        Error,
        "the target file is locked",
      );
      assertEquals(await Deno.readTextFile(file), "old\n");
      assertEquals(await pathExists(`${file}.writing`), false);
    });
  });

  test("reports a temp file it cannot remove and still throws the write's error", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "listing.ts");
      await Deno.writeTextFile(file, "old\n");
      const failure = new Error("the target file is locked");
      const { errors } = await captureConsole(() =>
        assertRejects(
          () =>
            writeWholeOrNotAtAll(file, "new\n", {
              remove: () =>
                Promise.reject(new Deno.errors.PermissionDenied("no")),
              rename: () => Promise.reject(failure),
              writeTextFile: Deno.writeTextFile,
            }),
          Error,
          "the target file is locked",
        ),
      );
      assertEquals(errors, [`Could not remove ${file}.writing: no`]);
    });
  });

  test("rethrows the write's own error when the temp file was never created", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "missing", "listing.ts");
      const { errors } = await captureConsole(() =>
        assertRejects(
          () => writeWholeOrNotAtAll(file, "new\n"),
          Deno.errors.NotFound,
        ),
      );
      assertEquals(errors, []);
    });
  });

  test("does not call the cleanup when the write succeeds", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "listing.ts");
      await Deno.writeTextFile(file, "old\n");
      const removed: string[] = [];
      await writeWholeOrNotAtAll(file, "new\n", {
        remove: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
        rename: Deno.rename,
        writeTextFile: Deno.writeTextFile,
      });
      assertEquals(await Deno.readTextFile(file), "new\n");
      assertEquals(await pathExists(`${file}.writing`), false);
      assertEquals(removed, []);
    });
  });
});
