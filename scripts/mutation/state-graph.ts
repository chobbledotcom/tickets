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

import {
  localFiles,
  type ModuleGraph,
  readModuleGraph,
  staticReachableSpecifiers,
} from "#scripts/module-graph.ts";

/** The module whose import graph produces the prebuilt test state. */
export const STATE_BUILDER_ROOT = "test/test-utils/test-state.ts";

/** Collect local files from a module graph rooted at `entry`, run from `cwd`. */
type GraphFiles = (entry: string, cwd: string) => Promise<Set<string>>;

/**
 * Build a `GraphFiles` from a derivation step that turns the parsed graph
 * into a set of specifiers. The entry read and the file:// filtering are
 * shared by every caller; only which specifiers count differs.
 */
const graphFilesFrom =
  (derive: (graph: ModuleGraph) => Set<string>): GraphFiles =>
  async (entry, cwd) =>
    localFiles(derive(await readModuleGraph(entry, cwd)));

/**
 * Absolute paths of every local file in `entry`'s import graph, resolved with
 * `deno info` from `cwd` (so the project's import map applies). Follows both
 * static and string-literal dynamic imports; non-file modules (npm:, jsr:,
 * data:) are left out.
 */
export const collectModuleGraphFiles: GraphFiles = graphFilesFrom(
  (graph) => new Set(graph.modules.map((module) => module.specifier)),
);

/** Breadth-first walk of the static-import graph from `graph.roots`. */
const walkStatic = (graph: ModuleGraph): Set<string> =>
  staticReachableSpecifiers(graph);

/**
 * Absolute paths of every local file reachable from `entry` through **static**
 * imports only — the modules that evaluate when the entry is imported, before
 * any request runs. Dynamic `import(...)` targets are excluded, so a module
 * behind a dynamic import does not appear here even though `deno info` lists
 * it in the graph. This is the set a cold-start regression test cares about:
 * a heavy module that creeps back onto this list costs every fresh isolate.
 */
export const staticGraphFiles: GraphFiles = graphFilesFrom(walkStatic);
