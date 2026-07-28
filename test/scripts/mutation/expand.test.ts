import { join, relative } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expand } from "#scripts/mutation/expand.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Globs are matched against the working directory, so a test that names files
 *  in a temporary folder has to ask from there. */
const expandFrom = async (dir: string, globs: string[]): Promise<string[]> => {
  const cwd = Deno.cwd();
  Deno.chdir(dir);
  try {
    return await expand(globs);
  } finally {
    Deno.chdir(cwd);
  }
};

const writeFile = async (
  path: string,
  body = "export {};\n",
): Promise<void> => {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, body);
};

describe("the files a glob names", () => {
  test("finds every match under a folder, sorted and without repeats", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "src", "b.ts"));
      await writeFile(join(dir, "src", "a.ts"));
      await writeFile(join(dir, "src", "deep", "c.ts"));
      await writeFile(join(dir, "src", "notes.txt"));

      const found = await expandFrom(dir, ["src/**/*.ts", "src/a.ts"]);

      expect(found.map((path) => relative(dir, path))).toEqual([
        join("src", "a.ts"),
        join("src", "b.ts"),
        join("src", "deep", "c.ts"),
      ]);
    });
  });

  test("names no files when the folder is not there", async () => {
    await withTempDir(async (dir) => {
      // A test file that moved is still named by a branch's committed diff, so
      // this is asked for in a normal run. Reading a missing folder only fails
      // once its entries are read, so a guard around opening it misses this.
      const found = await expandFrom(dir, ["gone/**/*.test.ts"]);

      expect(found).toEqual([]);
    });
  });

  test("names no files when the path is a file, not a folder", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.ts"));

      expect(await expandFrom(dir, ["a.ts/*.ts"])).toEqual([]);
    });
  });

  test("names an exact file, and skips one that is not there", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "src", "only.ts"));

      expect(await expandFrom(dir, ["src/only.ts"])).toEqual([
        join(dir, "src", "only.ts"),
      ]);
      expect(await expandFrom(dir, ["src/missing.ts"])).toEqual([]);
    });
  });
});
