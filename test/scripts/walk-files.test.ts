import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  collectScriptFiles,
  collectSourceFiles,
  directoryEntries,
} from "#scripts/walk-files.ts";

/** A small tree on disk, removed when the test ends. */
const inTempTree = async (
  names: readonly string[],
  use: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/nested`);
    for (const name of names) await Deno.writeTextFile(`${root}/${name}`, "");
    await use(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

/** Every collected path with the temporary root cut off the front. */
const below = (root: string, files: readonly string[]): string[] =>
  files.map((file) => file.slice(root.length + 1));

const TREE = [
  "a.ts",
  "b.tsx",
  "c.js",
  "d.mjs",
  "e.json",
  "f.css",
  "nested/g.ts",
  "nested/h.js",
];

describe("collectSourceFiles", () => {
  test("takes the TypeScript files, at any depth, in order", async () => {
    await inTempTree(TREE, async (root) => {
      expect(below(root, await collectSourceFiles(root))).toEqual([
        "a.ts",
        "b.tsx",
        "nested/g.ts",
      ]);
    });
  });
});

describe("collectScriptFiles", () => {
  test("takes the JavaScript files too, and nothing that is not code", async () => {
    await inTempTree(TREE, async (root) => {
      expect(below(root, await collectScriptFiles(root))).toEqual([
        "a.ts",
        "b.tsx",
        "c.js",
        "d.mjs",
        "nested/g.ts",
        "nested/h.js",
      ]);
    });
  });
});

describe("directoryEntries", () => {
  test("refuses a directory that is not there, rather than saying it is empty", async () => {
    await expect(directoryEntries("/no/such/directory")).rejects.toThrow();
  });
});
