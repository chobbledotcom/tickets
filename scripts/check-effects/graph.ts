/** The import graph behind the effect table, as pure functions: build the
 * graph from source texts, then show one chain of imports from a file to
 * an effect root as evidence. */

import { join, normalize } from "@std/path";
import {
  type Alias,
  resolveSpecifier,
  topLevelImports,
} from "#scripts/check-imports/rules.ts";
import { parseProgram, visitNodes } from "#scripts/parse-program.ts";

/** One source file and its text, as the graph builder reads it. */
export interface SourceFile {
  readonly content: string;
  readonly file: string;
}

/** Each walked file, and the local files its runtime imports (static and
 * dynamic) load. */
export type ModuleGraph = ReadonlyMap<string, readonly string[]>;

/** The local file one import specifier loads, or null when it names an
 * external package or an alias the table does not hold. */
export const resolveSpecifierToFile = (
  specifier: string,
  fromFile: string,
  aliases: Alias[],
): string | null => {
  if (specifier.startsWith("#")) {
    const target = resolveSpecifier(aliases, specifier);
    return target === null ? null : normalize(target).replace(/^\.\//, "");
  }
  if (specifier.startsWith(".")) {
    return normalize(join(fromFile, "..", specifier));
  }
  return null;
};

/** Every literal dynamic-import specifier in one parsed module. A
 * dynamic import with a computed specifier loads nothing this graph can
 * name. */
const dynamicImportSpecifiers = (
  file: string,
  content: string,
): readonly string[] => {
  const specifiers: string[] = [];
  visitNodes(parseProgram(file, content), (node) => {
    const source = node.source;
    if (
      node.type === "ImportExpression" &&
      typeof source === "object" &&
      source !== null &&
      "value" in source &&
      typeof source.value === "string"
    ) {
      specifiers.push(source.value);
    }
  });
  return specifiers;
};

/** The local files one module's runtime imports load. A type-only
 * import or re-export loads nothing; a runtime re-export loads its
 * source like an import. A resolved path outside the walked set holds
 * no effect data and stays out. */
const importsOf = (
  file: string,
  content: string,
  aliases: Alias[],
  walkedFiles: ReadonlySet<string>,
): readonly string[] => {
  const staticSpecifiers = topLevelImports(file, content)
    .filter((line) => !line.typeOnly)
    .map((line) => line.specifier);
  const specifiers = [
    ...staticSpecifiers,
    ...dynamicImportSpecifiers(file, content),
  ];
  return specifiers
    .map((specifier) => resolveSpecifierToFile(specifier, file, aliases))
    .filter(
      (target): target is string => target !== null && walkedFiles.has(target),
    );
};

/** Build the graph over the walked files. */
export const moduleGraph = (
  files: readonly SourceFile[],
  aliases: Alias[],
  walkedFiles: ReadonlySet<string>,
): ModuleGraph => {
  const graph = new Map<string, readonly string[]>();
  for (const { content, file } of files) {
    graph.set(file, importsOf(file, content, aliases, walkedFiles));
  }
  return graph;
};

/** One chain of imports from `file` to a root that carries the effect,
 * or null when the file carries no such root. The chain names the file
 * itself and every import hop to the root. */
export const chainToEffect = (
  graph: ModuleGraph,
  rootFiles: ReadonlySet<string>,
  file: string,
): readonly string[] | null => {
  const parent = new Map<string, string>();
  const queue = [file];
  for (const current of queue) {
    if (rootFiles.has(current)) {
      const chain = [current];
      let step = parent.get(current);
      while (step !== undefined) {
        chain.push(step);
        step = parent.get(step);
      }
      return chain.reverse();
    }
    for (const next of graph.get(current) ?? []) {
      if (next !== file && !parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
};
