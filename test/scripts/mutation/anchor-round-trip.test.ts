/**
 * The invariant the whole registry rests on: a mutant's key must survive being
 * written to a registry line and read back, and must still name that one
 * mutant.
 *
 * Every past failure of this registry broke one leg of that trip. A key that
 * could not be written kept its `#` and was truncated into a comment. A key
 * that could not be read back was skipped in silence. A key that read back but
 * named a different mutant let an unaudited survivor pass as equivalent. These
 * cases walk the trip end to end over real source, so the next break is a
 * failing test rather than a reviewer's catch.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ANCHOR_PATTERN } from "#scripts/mutation/anchor.ts";
import { generateMutants } from "#scripts/mutation/generate.ts";
import { mutantKeyForPath, parseIgnoreLine } from "#scripts/mutation/ignore.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** Real files, picked to span the shapes anchors have to cope with: dense
 * pure logic, JSX, a class, and a file of top-level declarations. */
const SAMPLES = [
  "src/fp.ts",
  "src/shared/dates.ts",
  "src/shared/largest-remainder.ts",
  "test/test-utils/test-browser.ts",
];

/** Awkward shapes that are legal TypeScript and have broken this before. */
const AWKWARD = [
  ['class R { "read it"(x) { return x ?? 0; } }\n', "a name holding a space"],
  [
    'class R { "a#b"(x) { return x ?? 0; } }\n',
    "a name holding a comment mark",
  ],
  ['class R { "a→b"(x) { return x ?? 0; } }\n', "a name holding an arrow"],
  ['const o = { "x y": () => 1 ?? 2 };\n', "an object key holding a space"],
  ["export default (globalThis.x ?? 0);\n", "code inside no declaration"],
  ["const f = () => () => () => 1 ?? 2;\n", "nesting with no names"],
] as const;

const keysIn = async (path: string): Promise<string[]> => {
  const file = `${projectRoot}/${path}`;
  const content = await Deno.readTextFile(file);
  return generateMutants(content, file, true).map((mutant) =>
    mutantKeyForPath(path, mutant),
  );
};

const keysOf = (source: string): string[] =>
  generateMutants(source, "/tmp/awkward.ts", true).map((mutant) =>
    mutantKeyForPath("src/awkward.ts", mutant),
  );

/** The registry line a key is written as, reason and all. A `from` side can
 * hold spaces (a removed statement) and an arrow (a string literal), so the
 * split matches the parser's: first space ends the location, first arrow ends
 * the `from`. */
const asRegistryLine = (key: string): string => {
  const space = key.indexOf(" ");
  const location = key.slice(0, space);
  const mutation = key.slice(space + 1);
  const arrow = mutation.indexOf("→");
  const from = mutation.slice(0, arrow);
  const to = mutation.slice(arrow + 1);
  return `${location}  ${from} → ${to}   # a reason mentioning # and → and spaces`;
};

describe("a mutant key survives the registry round trip", () => {
  for (const path of SAMPLES) {
    test(`every key in ${path} writes and reads back unchanged`, async () => {
      const keys = await keysIn(path);
      expect(keys.length).toBeGreaterThan(0);

      const readBack = keys.map(
        (key) => parseIgnoreLine(asRegistryLine(key))?.key,
      );

      expect(readBack).toEqual(keys);
    });

    test(`every anchor in ${path} holds only anchor characters`, async () => {
      const anchors = (await keysIn(path)).map(
        (key) => key.slice(key.indexOf("::") + 2).split(" ")[0]!,
      );

      expect(anchors.filter((a) => !ANCHOR_PATTERN.test(a))).toEqual([]);
    });

    test(`every key in ${path} names one mutant only`, async () => {
      const keys = await keysIn(path);

      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  for (const [source, what] of AWKWARD) {
    test(`survives ${what}`, () => {
      const keys = keysOf(source);
      expect(keys.length).toBeGreaterThan(0);

      const readBack = keys.map(
        (key) => parseIgnoreLine(asRegistryLine(key))?.key,
      );

      expect(readBack).toEqual(keys);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }
});
