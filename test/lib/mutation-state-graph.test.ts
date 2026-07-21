import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  collectModuleGraphFiles,
  STATE_BUILDER_ROOT,
} from "#scripts/mutation/state-graph.ts";
import { tempDir } from "#test-utils/files.ts";

/** Scratch modules: an entry with one static import, one dynamic import, and
 * one data: import (a non-file module that must be left out), plus a file
 * nothing imports. */
const SCRATCH_MODULES: Record<string, string> = {
  "dynamic-dep.ts": "export const dynamicDep = 2;\n",
  "entry.ts": [
    'import "./static-dep.ts";',
    'import "data:text/typescript,export const zero = 0;";',
    'export const load = () => import("./dynamic-dep.ts");',
    "",
  ].join("\n"),
  "static-dep.ts": "export const staticDep = 1;\n",
  "unrelated.ts": "export const unrelated = 3;\n",
};

describe("mutation > state graph", () => {
  const writeScratchModules = async (root: string): Promise<void> => {
    for (const [name, source] of Object.entries(SCRATCH_MODULES)) {
      await Deno.writeTextFile(`${root}/${name}`, source);
    }
  };

  test("collects the entry plus its static and dynamic imports, nothing else", async () => {
    using temp = tempDir({ prefix: "tickets-state-graph-" });
    const root = temp.path;
    await writeScratchModules(root);
    const files = await collectModuleGraphFiles("entry.ts", root);
    // Exact set: unrelated.ts is not imported and the data: module is not a
    // file, so neither may appear.
    expect([...files].sort()).toEqual([
      `${root}/dynamic-dep.ts`,
      `${root}/entry.ts`,
      `${root}/static-dep.ts`,
    ]);
  });

  test("fails loudly when a module cannot be resolved", async () => {
    // `deno info` exits 0 for an unresolvable module and reports the failure
    // inside the JSON; silently skipping it would under-count the graph.
    using temp = tempDir({ prefix: "tickets-state-graph-" });
    await expect(
      collectModuleGraphFiles("missing.ts", temp.path),
    ).rejects.toThrow("Module not found");
  });

  test("fails loudly when deno info itself fails", async () => {
    using temp = tempDir({ prefix: "tickets-state-graph-" });
    // A malformed deno.json in the cwd makes `deno info` exit non-zero
    // before it can emit any graph.
    await Deno.writeTextFile(`${temp.path}/deno.json`, "{invalid");
    await expect(
      collectModuleGraphFiles("entry.ts", temp.path),
    ).rejects.toThrow("deno info --json entry.ts failed (exit 1)");
  });

  test("the state-builder root points at a real module", async () => {
    // Tests run from the project root, so the relative constant resolves. If
    // test-state.ts ever moves, this pins the constant to move with it.
    const stat = await Deno.stat(STATE_BUILDER_ROOT);
    expect(stat.isFile).toBe(true);
  });
});
