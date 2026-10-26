import { join, relative } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expand } from "#scripts/mutation/expand.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Globs are matched from a starting folder, so a test names its own without
 *  touching the working directory this whole process shares. */
const expandFrom = (dir: string, globs: string[]): Promise<string[]> =>
  expand(globs, dir);

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

  test("names the files an extglob segment accepts", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "src", "a.ts"));
      await writeFile(join(dir, "src", "b.ts"));
      await writeFile(join(dir, "src", "c.ts"));

      // The segment reads as one folder name to a fixed-directory scan, so it
      // must end the fixed prefix the way a star does.
      const found = await expandFrom(dir, ["src/+(a|b).ts", "src/!(c).ts"]);

      expect(found.map((path) => relative(dir, path))).toEqual([
        join("src", "a.ts"),
        join("src", "b.ts"),
      ]);
    });
  });

  test("names the files an extglob folder accepts", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "src", "a", "x.ts"));
      await writeFile(join(dir, "src", "b", "x.ts"));
      await writeFile(join(dir, "src", "c", "x.ts"));

      const found = await expandFrom(dir, ["src/+(a|b)/x.ts"]);

      expect(found.map((path) => relative(dir, path))).toEqual([
        join("src", "a", "x.ts"),
        join("src", "b", "x.ts"),
      ]);
    });
  });

  test("reads an escape prefix the way the matcher does", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "src", "a@b.ts"));
      await writeFile(join(dir, "src", "a\\@b.ts"));

      // `\@` reads as a plain `@` to the matcher, and a doubled `\\` reads as
      // one backslash. Read as one fixed name, the single escape looks for a
      // file that carries the backslash itself, and that file is not there.
      expect(await expandFrom(dir, ["src/a\\@b.ts", "src/a\\\\@b.ts"])).toEqual(
        [join(dir, "src", "a@b.ts"), join(dir, "src", "a\\@b.ts")],
      );
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

  test("names a file for every plain character a glob segment can carry", async () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const char = String.fromCharCode(code);
      // A separator cannot sit inside a name, and the escape prefix points
      // past itself; the test above covers it.
      if (char === "/" || char === "\\") continue;
      await withTempDir(async (dir) => {
        const name = `a${char}b.ts`;
        await writeFile(join(dir, "src", name));

        expect(await expandFrom(dir, [`src/${name}`])).toEqual([
          join(dir, "src", name),
        ]);
      });
    }
  });

  test("matches from where it is asked when the glob starts with a star", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "top.ts"));
      await writeFile(join(dir, "nested", "deep.ts"));

      const found = await expandFrom(dir, ["*.ts"]);

      expect(found.map((path) => relative(dir, path))).toEqual(["top.ts"]);
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
