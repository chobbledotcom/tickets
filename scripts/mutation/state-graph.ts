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
import { runCommand } from "#scripts/precommit/git.ts";

/** The module whose import graph produces the prebuilt test state. */
export const STATE_BUILDER_ROOT = "test/test-utils/test-state.ts";

// `deno info --json` emits a richer per-module object; only the fields used
// here are declared, the rest is ignored by valibot's strip behaviour.
const DependencySchema = v.object({
  // The resolved specifier of the runtime (code) dependency. Absent for
  // type-only imports — those never evaluate, so they are not part of any
  // graph we walk.
  code: v.optional(v.object({ specifier: v.string() })),
  // Present and `true` only when the dependency is a dynamic `import(...)`.
  // Static imports omit the key entirely.
  isDynamic: v.optional(v.boolean()),
  // The specifier as written in the source (`"#routes/auth.ts"`, `"./x.ts"`).
  specifier: v.string(),
});

const ModuleGraphSchema = v.object({
  modules: v.array(
    v.object({
      dependencies: v.optional(v.array(DependencySchema)),
      error: v.optional(v.string()),
      specifier: v.string(),
    }),
  ),
  // `deno info --json` always emits `roots` for a local entry; requiring it
  // means a future Deno that drops the field fails loudly here instead of
  // silently producing an empty graph that would let a cold-start regression
  // pass trivially.
  roots: v.array(v.string()),
});

/** Run `deno info --json` for `entry` from `cwd`, failing loudly on errors. */
const readModuleGraph = async (
  entry: string,
  cwd: string,
): Promise<v.InferOutput<typeof ModuleGraphSchema>> => {
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
  return graph;
};

/** Keep only file:// specifiers, converted to absolute paths. */
const localFiles = (specifiers: Iterable<string>): Set<string> =>
  new Set(
    [...specifiers]
      .filter((specifier) => specifier.startsWith("file://"))
      .map((specifier) => fromFileUrl(specifier)),
  );

/** Collect local files from a module graph rooted at `entry`, run from `cwd`. */
type GraphFiles = (entry: string, cwd: string) => Promise<Set<string>>;

/**
 * Build a `GraphFiles` from a derivation step that turns the parsed graph
 * into a set of specifiers. The entry read and the file:// filtering are
 * shared by every caller; only which specifiers count differs.
 */
const graphFilesFrom =
  (
    derive: (graph: v.InferOutput<typeof ModuleGraphSchema>) => Set<string>,
  ): GraphFiles =>
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

/**
 * Resolved specifiers of the **static** runtime deps of one module. Drops
 * type-only imports (they never evaluate) and dynamic `import(...)` (it is
 * deferred). This is the one relation the cold-start walk cares about.
 */
const staticCodeSpecifiers = (
  deps: readonly v.InferOutput<typeof DependencySchema>[],
): readonly string[] =>
  deps
    .filter((dep) => !dep.isDynamic)
    .map((dep) => dep.code?.specifier)
    .filter((specifier): specifier is string => !!specifier);

/** Breadth-first walk of the static-import graph from `graph.roots`. */
const walkStatic = (
  graph: v.InferOutput<typeof ModuleGraphSchema>,
): Set<string> => {
  const bySpecifier = new Map(
    graph.modules.map((module) => [module.specifier, module]),
  );
  const seen = new Set<string>();
  const queue = [...graph.roots];

  while (queue.length > 0) {
    const specifier = queue.shift();
    if (!specifier || seen.has(specifier) || !bySpecifier.has(specifier)) {
      continue;
    }
    seen.add(specifier);
    const deps = bySpecifier.get(specifier)?.dependencies ?? [];
    for (const resolved of staticCodeSpecifiers(deps)) {
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
};

/**
 * Absolute paths of every local file reachable from `entry` through **static**
 * imports only — the modules that evaluate when the entry is imported, before
 * any request runs. Dynamic `import(...)` targets are excluded, so a module
 * behind a dynamic import does not appear here even though `deno info` lists
 * it in the graph. This is the set a cold-start regression test cares about:
 * a heavy module that creeps back onto this list costs every fresh isolate.
 */
export const staticGraphFiles: GraphFiles = graphFilesFrom(walkStatic);
