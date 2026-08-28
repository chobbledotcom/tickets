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

// One module entry, normalised as it parses: a module with no dependencies
// gets an empty list right at the boundary, so every reader downstream
// trusts the list instead of coalescing an undefined away.
const ModuleSchema = v.pipe(
  v.object({
    dependencies: v.optional(v.array(DependencySchema)),
    error: v.optional(v.string()),
    specifier: v.string(),
  }),
  v.transform((module) => ({
    ...module,
    dependencies: module.dependencies ?? [],
  })),
);

const ModuleGraphSchema = v.object({
  modules: v.array(ModuleSchema),
  // `deno info --json` always emits `roots` for a local entry; requiring it
  // means a future Deno that drops the field fails loudly here instead of
  // silently producing an empty graph that would let a cold-start regression
  // pass trivially.
  roots: v.array(v.string()),
});

export type ModuleGraph = v.InferOutput<typeof ModuleGraphSchema>;
type Dependency = v.InferOutput<typeof DependencySchema>;

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
const staticCodeSpecifiers = (deps: readonly Dependency[]): readonly string[] =>
  codeSpecifiers(deps, false);

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

/** Breadth-first walk from `graph.roots` over each module's runtime (code)
 * deps — dynamic ones followed only when `followDynamic` says so. */
const reachableModules = (
  graph: ModuleGraph,
  followDynamic: boolean,
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
    const module = bySpecifier.get(specifier)!;
    const runtimeImports = codeSpecifiers(module.dependencies, followDynamic);
    for (const resolved of runtimeImports) {
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
};

/**
 * The static import targets of every module in the graph, keyed by the
 * module's own specifier. Dynamic and type-only imports are absent: a
 * deferred import decides no load order here, and a type import names no
 * runtime target at all.
 */
export const staticImportsBySpecifier = (
  graph: ModuleGraph,
): Map<string, readonly string[]> => {
  const bySpecifier = new Map<string, readonly string[]>();
  for (const module of graph.modules) {
    const staticImports = staticCodeSpecifiers(module.dependencies);
    bySpecifier.set(module.specifier, staticImports);
  }
  return bySpecifier;
};

/**
 * The modules the entry can reach at runtime: static imports plus dynamic
 * ones, because a deferred module still evaluates on first use. Type-only
 * imports reach nothing — a module only they can reach never evaluates, so
 * cycles inside that subtree cost no load order and no cold start.
 */
export const runtimeReachableSpecifiers = (graph: ModuleGraph): Set<string> =>
  reachableModules(graph, true);

/** The modules the entry reaches through static imports alone — the set a
 * cold-start regression cares about, before any deferred import fires. */
export const staticReachableSpecifiers = (graph: ModuleGraph): Set<string> =>
  reachableModules(graph, false);
