/**
 * Holds `src/` at the rings of modules it already carries.
 *
 * A ring of modules that import each other is a standing hazard: whichever
 * module the runtime evaluates second reads a name the first has not reached
 * yet, and the app dies at startup with "Cannot access X before
 * initialization". Which module loses that race depends on the entry point, so
 * a ring can pass the whole Deno suite and take every Cucumber spec down.
 *
 * The rings below are the ones this tree had when the check arrived. **The
 * list only shrinks.** A ring that is not on it fails, and an entry that
 * matches nothing any more fails too, so breaking a ring has to take its entry
 * with it.
 *
 * The detector lives in `test/scripts/code-quality/import-cycles.ts` and is
 * proven with crafted trees in its own test — this file is only the "is the
 * live codebase clean?" half, which is why the list sits here.
 */

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Alias } from "#scripts/check-imports/rules.ts";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import {
  importCycles,
  modulesOf,
  type SourceFile,
} from "#test/scripts/code-quality/import-cycles.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every ring `src/` carries today, each sorted, and the rings in the order
 *  the detector reports them. Each says why it is still standing. */
const KNOWN_RINGS: string[][] = [
  // A group and its membership each need to ask the other what a listing
  // belongs to before they can answer.
  ["src/shared/db/groups.ts", "src/shared/db/groups/membership.ts"],
  // A listing's parents, prices and records each need to ask the others what
  // a listing belongs to before they can answer.
  [
    "src/shared/db/listing-parents.ts",
    "src/shared/db/listing-prices.ts",
    "src/shared/db/listings/records.ts",
  ],
];

/** The alias table, read the way the import check reads it. */
const readAliases = async (): Promise<Alias[]> => {
  const config = await Deno.readTextFile(join(REPO_ROOT, "deno.json"));
  const { imports } = JSON.parse(config) as { imports: Record<string, string> };
  return Object.entries(imports).map(([name, target]) => ({ name, target }));
};

/** Every module under `src/`, keyed by its path from the repository root. */
const readSource = async (): Promise<SourceFile[]> => {
  const paths = await collectSourceFiles(join(REPO_ROOT, "src"));
  return Promise.all(
    paths.map(async (path) => ({
      content: await Deno.readTextFile(path),
      path: relative(REPO_ROOT, path).replaceAll("\\", "/"),
    })),
  );
};

describe("import cycles", () => {
  test("src carries only the rings already recorded here", async () => {
    const [files, aliases] = await Promise.all([readSource(), readAliases()]);
    expect(importCycles(modulesOf(files, aliases))).toEqual(KNOWN_RINGS);
  });

  test("a recorded ring carries only the edges it was recorded with", async () => {
    // The ring list names each ring's members, but a ring can gain an edge —
    // and with it a shorter path around — without gaining a member, which the
    // members alone cannot say. So the edges between recorded members are held
    // here too: a new edge inside a ring fails, exactly as a new ring does.
    const [files, aliases] = await Promise.all([readSource(), readAliases()]);
    const loads = new Map(
      modulesOf(files, aliases).map((module) => [module.path, module.loads]),
    );
    const edges = KNOWN_RINGS.flatMap((ring) => {
      const members = new Set(ring);
      return ring.flatMap((from) =>
        (loads.get(from) ?? [])
          .filter((to) => members.has(to))
          .map((to) => `${from} -> ${to}`),
      );
    }).sort();
    expect(edges).toEqual([
      "src/shared/db/groups.ts -> src/shared/db/groups/membership.ts",
      "src/shared/db/groups/membership.ts -> src/shared/db/groups.ts",
      "src/shared/db/listing-parents.ts -> src/shared/db/listings/records.ts",
      "src/shared/db/listing-prices.ts -> src/shared/db/listing-parents.ts",
      "src/shared/db/listings/records.ts -> src/shared/db/listing-prices.ts",
    ]);
  });
});
