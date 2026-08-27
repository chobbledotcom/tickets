import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Alias } from "#scripts/check-imports/rules.ts";
import {
  importCycles,
  modulesOf,
  type SourceFile,
} from "#test/scripts/code-quality/import-cycles.ts";

const ALIASES: Alias[] = [
  { name: "#shared/", target: "./src/shared/" },
  { name: "#types", target: "./src/shared/types.ts" },
];

/** One tree, written as a path and the lines that file holds. */
const tree = (files: Record<string, string>): SourceFile[] =>
  Object.entries(files).map(([path, content]) => ({ content, path }));

const ringsIn = (files: Record<string, string>): string[][] =>
  importCycles(modulesOf(tree(files), ALIASES));

/** What one named module loads. Looked up by path, because the formatter
 *  sorts the keys of the tree written above. */
const loadsOf = (
  files: Record<string, string>,
  path: string,
): readonly string[] =>
  modulesOf(tree(files), ALIASES).find((module) => module.path === path)
    ?.loads ?? [];

describe("modulesOf", () => {
  test("follows an alias to the file it names", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual(["src/shared/b.ts"]);
  });

  test("follows a sibling import to the file beside it", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'import { b } from "./b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual(["src/shared/b.ts"]);
  });

  test("follows an import that walks up a folder", () => {
    expect(
      loadsOf(
        {
          "src/shared/b.ts": "",
          "src/shared/db/a.ts": 'import { b } from "../b.ts";',
        },
        "src/shared/db/a.ts",
      ),
    ).toEqual(["src/shared/b.ts"]);
  });

  test("follows a re-export, which loads its module at run time", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'export { b } from "#shared/b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual(["src/shared/b.ts"]);
  });

  test("drops a type-only re-export, which is erased before anything runs", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'export type { B } from "#shared/b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual([]);
  });

  test("follows a side-effect import, which loads its module for what it does", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'import "#shared/b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual(["src/shared/b.ts"]);
  });

  test("drops an import of a package, which is outside the tree", () => {
    expect(
      loadsOf(
        { "src/shared/a.ts": 'import * as v from "valibot";' },
        "src/shared/a.ts",
      ),
    ).toEqual([]);
  });

  test("drops an import of a file the tree does not hold", () => {
    expect(
      loadsOf(
        { "src/shared/a.ts": 'import { b } from "#shared/gone.ts";' },
        "src/shared/a.ts",
      ),
    ).toEqual([]);
  });

  test("drops a type-only import, which is erased before anything runs", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'import type { B } from "#shared/b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual([]);
  });

  test("keeps an import that brings in a value beside a type", () => {
    expect(
      loadsOf(
        {
          "src/shared/a.ts": 'import { type B, make } from "#shared/b.ts";',
          "src/shared/b.ts": "",
        },
        "src/shared/a.ts",
      ),
    ).toEqual(["src/shared/b.ts"]);
  });
});

describe("importCycles", () => {
  test("finds nothing when every module loads in one direction", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
        "src/shared/b.ts": 'import { c } from "#shared/c.ts";',
        "src/shared/c.ts": "",
      }),
    ).toEqual([]);
  });

  test("finds two modules that load each other", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
        "src/shared/b.ts": 'import { a } from "#shared/a.ts";',
      }),
    ).toEqual([["src/shared/a.ts", "src/shared/b.ts"]]);
  });

  test("finds a ring that closes through a third module", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
        "src/shared/b.ts": 'import { c } from "#shared/c.ts";',
        "src/shared/c.ts": 'import { a } from "#shared/a.ts";',
      }),
    ).toEqual([["src/shared/a.ts", "src/shared/b.ts", "src/shared/c.ts"]]);
  });

  test("finds a ring that closes through a re-export", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'export { b } from "#shared/b.ts";',
        "src/shared/b.ts": 'import { a } from "#shared/a.ts";',
      }),
    ).toEqual([["src/shared/a.ts", "src/shared/b.ts"]]);
  });

  test("finds a ring that closes through a side-effect import", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import "#shared/b.ts";',
        "src/shared/b.ts": 'import { a } from "#shared/a.ts";',
      }),
    ).toEqual([["src/shared/a.ts", "src/shared/b.ts"]]);
  });

  test("keeps two separate rings apart", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
        "src/shared/b.ts": 'import { a } from "#shared/a.ts";',
        "src/shared/y.ts": 'import { z } from "#shared/z.ts";',
        "src/shared/z.ts": 'import { y } from "#shared/y.ts";',
      }),
    ).toEqual([
      ["src/shared/a.ts", "src/shared/b.ts"],
      ["src/shared/y.ts", "src/shared/z.ts"],
    ]);
  });

  test("leaves a module that loads itself out, having no second member", () => {
    expect(
      ringsIn({ "src/shared/a.ts": 'import { a } from "#shared/a.ts";' }),
    ).toEqual([]);
  });

  test("leaves a ring of type-only imports alone", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import type { B } from "#shared/b.ts";',
        "src/shared/b.ts": 'import type { A } from "#shared/a.ts";',
      }),
    ).toEqual([]);
  });

  test("names a ring the same way whichever module the walk meets first", () => {
    const files = {
      "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
      "src/shared/b.ts": 'import { a } from "#shared/a.ts";',
    };
    const forwards = importCycles(modulesOf(tree(files), ALIASES));
    const backwards = importCycles(modulesOf(tree(files).reverse(), ALIASES));
    expect(backwards).toEqual(forwards);
  });

  test("walks past a module that loads something the list does not hold", () => {
    expect(
      importCycles([
        { loads: ["src/shared/gone.ts"], path: "src/shared/a.ts" },
      ]),
    ).toEqual([]);
  });

  test("finds a module that reaches a ring without joining it", () => {
    expect(
      ringsIn({
        "src/shared/a.ts": 'import { b } from "#shared/b.ts";',
        "src/shared/b.ts": 'import { a } from "#shared/a.ts";',
        "src/shared/outside.ts": 'import { a } from "#shared/a.ts";',
      }),
    ).toEqual([["src/shared/a.ts", "src/shared/b.ts"]]);
  });
});
