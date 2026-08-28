/**
 * Reading the local module graph with `deno info --json`. Shared by every
 * tool that needs to know what imports what: the mutation state graph and
 * the import-cycle report.
 *
 * The two distinctions that matter to every reader:
 * - a dependency with no `code` specifier is type-only, and types never
 *   evaluate, so they belong to no runtime graph;
 * - a dependency marked `isDynamic` is deferred to first use, so it costs
 *   no cold start and creates no load-order cycle.
 */

import { fromFileUrl } from "@std/path";
import * as v from "valibot";
import { runCommand } from "#scripts/precommit/git.ts";

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

export type ModuleGraph = v.InferOutput<typeof ModuleGraphSchema>;
type Dependency = v.InferOutput<typeof DependencySchema>;
type GraphModule = ModuleGraph["modules"][number];

/** Run `deno info --json` for `entry` from `cwd`, failing loudly on errors. */
export const readModuleGraph = async (
  entry: string,
  cwd: string,
): Promise<ModuleGraph> => {
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
export const localFiles = (specifiers: Iterable<string>): Set<string> =>
  new Set(
    [...specifiers]
      .filter((specifier) => specifier.startsWith("file://"))
      .map((specifier) => fromFileUrl(specifier)),
  );

/**
 * Resolved specifiers of the **static** runtime deps of one module. Drops
 * type-only imports (they never evaluate) and dynamic `import(...)` (it is
 * deferred).
 */
export const staticCodeSpecifiers = (
  deps: readonly Dependency[],
): readonly string[] => codeSpecifiers(deps, false);

/** Resolved runtime (code) deps of one module, dynamic ones included when
 * `includeDynamic` says so — a deferred module still evaluates on first use. */
const codeSpecifiers = (
  deps: readonly Dependency[],
  includeDynamic: boolean,
): readonly string[] =>
  deps
    .filter((dep) => includeDynamic || !dep.isDynamic)
    .map((dep) => dep.code?.specifier)
    .filter((specifier): specifier is string => !!specifier);

/** Breadth-first walk from `graph.roots` over the edges `edgesOf` names.
 * Shared by every reachability question over a module graph. */
export const reachableSpecifiers = (
  graph: ModuleGraph,
  edgesOf: (module: GraphModule) => readonly string[],
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
    for (const resolved of edgesOf(bySpecifier.get(specifier)!)) {
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
};

/**
 * A module's runtime edges, dynamic imports included — the relation behind
 * the runtime-reachability walk.
 */
const runtimeEdgesOf = (module: GraphModule): readonly string[] =>
  codeSpecifiers(module.dependencies ?? [], true);

/** A module's static edges only — the walk the cold-start question uses. */
export const staticEdgesOf = (module: GraphModule): readonly string[] =>
  staticCodeSpecifiers(module.dependencies ?? []);

/**
 * The modules the entry can reach at runtime: static imports plus dynamic
 * ones, because a deferred module still evaluates on first use. Type-only
 * imports reach nothing — a module only they can reach never evaluates, so
 * cycles inside that subtree cost no load order and no cold start.
 */
export const runtimeReachableSpecifiers = (graph: ModuleGraph): Set<string> =>
  reachableSpecifiers(graph, runtimeEdgesOf);
