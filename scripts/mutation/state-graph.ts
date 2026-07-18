/**
 * Which files feed the run-wide prebuilt test state (the golden schema DB plus
 * the captured setup ceremony) that the harness exports via
 * TICKETS_TEST_STATE_DIR — see test/test-utils/test-state.ts.
 *
 * The harness builds that state once, before any mutant is written. A mutant
 * in a module the state builder runs — the schema tables, the migrations list,
 * the setup ceremony's settings and crypto paths — would be tested against
 * fixtures produced by the *unmutated* code and could falsely survive. The
 * runner uses this graph to find exactly those files. Direct tests run without
 * the stale state. Integration tests share one fresh state built from the
 * mutant, instead of rebuilding the same database in every test isolate. This
 * mirrors the per-mutant client-bundle rebuild owned by the static asset build.
 */

import { fromFileUrl } from "@std/path";
import * as v from "valibot";
import { runCommand } from "../precommit/git.ts";

/** The module whose import graph produces the prebuilt test state. */
export const STATE_BUILDER_ROOT = "test/test-utils/test-state.ts";

// Only the specifiers (and any per-module error) matter here; `deno info`
// emits much more per module.
const ModuleGraphSchema = v.object({
  modules: v.array(
    v.object({ error: v.optional(v.string()), specifier: v.string() }),
  ),
});

/**
 * Absolute paths of every local file in `entry`'s import graph, resolved with
 * `deno info` from `cwd` (so the project's import map applies). Follows both
 * static and string-literal dynamic imports; non-file modules (npm:, jsr:,
 * data:) are left out.
 */
export const collectModuleGraphFiles = async (
  entry: string,
  cwd: string,
): Promise<Set<string>> => {
  const result = await runCommand([Deno.execPath(), "info", "--json", entry], {
    cwd,
  });
  if (!result.success) {
    throw new Error(
      `deno info --json ${entry} failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  const graph = v.parse(ModuleGraphSchema, JSON.parse(result.stdout));
  // `deno info` exits 0 even when a module fails to resolve, reporting the
  // failure per module instead. A module that failed to resolve has an
  // unwalked dependency tree, so treating it as absent would silently
  // under-count the graph — fail loudly instead.
  for (const module of graph.modules) {
    if (module.error !== undefined) {
      throw new Error(`deno info --json ${entry}: ${module.error}`);
    }
  }
  return new Set(
    graph.modules
      .map((module) => module.specifier)
      .filter((specifier) => specifier.startsWith("file://"))
      .map((specifier) => fromFileUrl(specifier)),
  );
};
