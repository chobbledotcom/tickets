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
export const DependencySchema = v.object({
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

export const ModuleGraphSchema = v.object({
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
export type Dependency = v.InferOutput<typeof DependencySchema>;

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
): readonly string[] =>
  deps
    .filter((dep) => !dep.isDynamic)
    .map((dep) => dep.code?.specifier)
    .filter((specifier): specifier is string => !!specifier);
