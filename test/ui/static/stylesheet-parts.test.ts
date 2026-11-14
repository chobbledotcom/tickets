/**
 * `src/ui/static/style.scss` holds only the ordered list of partials. The
 * compiled stylesheet keeps a rule only when the list names the partial that
 * holds it, so a partial that the page builds but the list forgets loses its
 * rules with no error. These tests hold the list and the partials together.
 */

import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";
import { directoryNames } from "#test-utils/files.ts";

const STYLESHEETS = join(projectRoot, "src/ui/static");

/** The entry that compiles to the served `style.css`. */
const ENTRY = "style.scss";

/** The partial that holds the shared mixins. It holds no rule, so the entry
 *  does not name it. */
const SHARED_MIXINS = "_mixins.scss";

const useLine = /^@use "(?<name>[^"]+)";$/;
const mixinDefinition = /^@mixin (?<name>[a-z-]+) \{$/;
const mixinInclude = /@include (?<name>[a-z-]+)/;
const blockComment = /\/\*[\s\S]*?\*\//g;

/** The file name of every stylesheet partial, sorted. */
const partialFileNames = (names: readonly string[]): string[] =>
  names.filter((name) => name.startsWith("_") && name.endsWith(".scss"));

/** The module name that a partial file name resolves to. */
const moduleOf = (fileName: string): string =>
  fileName.slice(1, -".scss".length);

/** The names that `pattern`'s `name` group captures in `text`, in order. */
const namesIn = (pattern: RegExp, text: string): string[] =>
  text.split("\n").flatMap((line) => {
    const name = pattern.exec(line)?.groups?.name;
    return name === undefined ? [] : [name];
  });

interface Stylesheet {
  /** The file name, such as `_app.scss`. */
  fileName: string;
  text: string;
}

/** Every stylesheet in the static directory, read. */
const readStylesheets = async (): Promise<Stylesheet[]> => {
  const names = await directoryNames(STYLESHEETS);
  const stylesheets: Stylesheet[] = [];
  for (const fileName of names.filter((name) => name.endsWith(".scss"))) {
    stylesheets.push({
      fileName,
      text: await Deno.readTextFile(join(STYLESHEETS, fileName)),
    });
  }
  return stylesheets;
};

/** The text of the stylesheet named `fileName`, or a loud failure. */
const textOf = (
  stylesheets: readonly Stylesheet[],
  fileName: string,
): string => {
  const found = stylesheets.find((sheet) => sheet.fileName === fileName);
  if (found === undefined)
    throw new Error(`The stylesheets hold no ${fileName}`);
  return found.text;
};

/** The mixin names that the shared mixin partial defines. */
const sharedMixinNames = (stylesheets: readonly Stylesheet[]): string[] =>
  namesIn(mixinDefinition, textOf(stylesheets, SHARED_MIXINS));

describe("the stylesheet entry", () => {
  test("names every partial once, and names no file that is not a partial", async () => {
    const stylesheets = await readStylesheets();
    const partials = partialFileNames(
      stylesheets.map((sheet) => sheet.fileName),
    )
      .filter((fileName) => fileName !== SHARED_MIXINS)
      .map(moduleOf);
    // A name that the list holds twice and a partial that it holds not at all
    // both move one partial's rules out of the cascade, so the sorted lists
    // must agree exactly.
    expect(namesIn(useLine, textOf(stylesheets, ENTRY)).toSorted()).toEqual(
      partials.toSorted(),
    );
  });

  test("holds no rule of its own, so every rule lives in a partial", async () => {
    const stylesheets = await readStylesheets();
    const outside = textOf(stylesheets, ENTRY)
      .replaceAll(blockComment, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !useLine.test(line));
    expect(outside).toEqual([]);
  });
});

describe("the shared mixins", () => {
  test("serves at least two rules each, so no mixin wraps one rule alone", async () => {
    const stylesheets = await readStylesheets();
    const defined = sharedMixinNames(stylesheets);
    expect(defined.length > 0).toBe(true);
    const includes = stylesheets.flatMap((sheet) =>
      namesIn(mixinInclude, sheet.text),
    );
    // The partial's own `@include` lines count: a mixin that another mixin
    // composes is in use.
    const usedOnce = defined.filter(
      (name) => includes.filter((included) => included === name).length < 2,
    );
    expect(usedOnce).toEqual([]);
  });

  test("joins a partial exactly where that partial includes one", async () => {
    const stylesheets = await readStylesheets();
    const defined = sharedMixinNames(stylesheets);
    const imports = `@use "${moduleOf(SHARED_MIXINS)}" as *;`;
    const mismatched = stylesheets
      .filter((sheet) => sheet.fileName !== SHARED_MIXINS)
      .filter((sheet) => {
        const importsShared = sheet.text.split("\n").includes(imports);
        const includesShared = namesIn(mixinInclude, sheet.text).some((name) =>
          defined.includes(name),
        );
        return importsShared !== includesShared;
      })
      .map((sheet) => sheet.fileName);
    expect(mismatched).toEqual([]);
  });
});
