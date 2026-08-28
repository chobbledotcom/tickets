/**
 * The pure core of the import-cycle report: which modules a graph's
 * load-time edges hold in mutual reachability, and how to say that on
 * screen. Data in, data out — the `deno info` read lives in run.ts.
 */

import { fromFileUrl, relative, SEPARATOR } from "@std/path";
import { requiredMapValue } from "#fp";
import {
  type ModuleGraph,
  runtimeReachableSpecifiers,
  staticImportsBySpecifier,
} from "#scripts/module-graph.ts";

/**
 * The load-time import edges of a graph: which modules reachable at runtime
 * evaluate which others. Keyed and valued by paths relative to `root`.
 * Type-only imports evaluate nothing and dynamic imports are deferred to
 * first use, so neither is an edge — a cycle through either costs no cold
 * start and no load order. Modules only a type import can reach are skipped
 * entirely: they never evaluate, so their inner cycles are not load-order
 * tangles. A module importing itself stays an edge: it is a tangle of one.
 */
export const loadTimeEdges = (
  graph: ModuleGraph,
  root: string,
): Map<string, Set<string>> => {
  const reachable = runtimeReachableSpecifiers(graph);
  const staticImports = staticImportsBySpecifier(graph);
  const edges = new Map<string, Set<string>>();
  const localUnderRoot = (specifier: string): string | null => {
    if (!specifier.startsWith("file://") || !reachable.has(specifier)) {
      return null;
    }
    // fromFileUrl decodes the URL: a repo path with a space arrives as
    // %20, and the undecoded form reads as outside the root.
    const path = relative(root, fromFileUrl(specifier));
    // A leading ".." must be the parent escape itself — a name such as
    // ..generated stays a module under the root.
    const escapesRoot = path === ".." || path.startsWith(`..${SEPARATOR}`);
    return escapesRoot ? null : path;
  };
  for (const [specifier, imports] of staticImports) {
    const from = localUnderRoot(specifier);
    if (from === null) continue;
    for (const toSpecifier of imports) {
      const to = localUnderRoot(toSpecifier);
      if (to === null) continue;
      const targets = edges.get(from) ?? new Set<string>();
      targets.add(to);
      edges.set(from, targets);
    }
  }
  return edges;
};

/** The modules of a graph in the order their imports finish loading: a
 * depth-first walk that records each module after everything it imports.
 * Iterative, so a deep graph cannot overflow the stack. */
const finishOrderOf = (nodes: string[], importsOf: number[][]): number[] => {
  const seen = new Array<boolean>(nodes.length).fill(false);
  const finished: number[] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (seen[start]) continue;
    seen[start] = true;
    const stack: [number, number][] = [[start, 0]];
    while (stack.length > 0) {
      const [node, next] = stack[stack.length - 1]!;
      if (next < importsOf[node]!.length) {
        stack[stack.length - 1]![1] = next + 1;
        const target = importsOf[node]![next]!;
        if (!seen[target]) {
          seen[target] = true;
          stack.push([target, 0]);
        }
      } else {
        stack.pop();
        finished.push(node);
      }
    }
  }
  return finished;
};

/** The groups of mutually-loading modules, walked off the finish order in
 * reverse: each unvisited module there starts one group. */
const groupsFromFinishOrder = (
  finished: number[],
  importersOf: number[][],
): number[][] => {
  const assigned = new Array<boolean>(finished.length).fill(false);
  const groups: number[][] = [];
  for (let i = finished.length - 1; i >= 0; i--) {
    const start = finished[i]!;
    if (assigned[start]) continue;
    const group: number[] = [];
    assigned[start] = true;
    const work = [start];
    while (work.length > 0) {
      const node = work.pop()!;
      group.push(node);
      for (const source of importersOf[node]!) {
        if (!assigned[source]) {
          assigned[source] = true;
          work.push(source);
        }
      }
    }
    groups.push(group);
  }
  return groups;
};

/**
 * The groups of modules that can each load the other — two or more modules,
 * or one module that imports itself — largest first, each member list
 * sorted. A group is a load-order tangle: any module in it pulls in every
 * other, and the count to work down is the group's size.
 */
export const cyclicGroups = (edges: Map<string, Set<string>>): string[][] => {
  const nodes = [
    ...new Set([
      ...edges.keys(),
      ...[...edges.values()].flatMap((targets) => [...targets]),
    ]),
  ];
  const index = new Map(nodes.map((node, i) => [node, i]));
  const importsOf = nodes.map((node) =>
    [...(edges.get(node) ?? [])]
      .filter((target) => index.has(target))
      .map((target) =>
        requiredMapValue(
          index,
          target,
          `Module index has no entry for ${target}`,
        ),
      ),
  );
  const importersOf = nodes.map(() => [] as number[]);
  for (const [from, targets] of importsOf.entries()) {
    for (const to of targets) importersOf[to]!.push(from);
  }
  const isTangle = (group: number[]): boolean =>
    group.length > 1 || importsOf[group[0]!]!.includes(group[0]!);
  return groupsFromFinishOrder(finishOrderOf(nodes, importsOf), importersOf)
    .filter(isTangle)
    .map((group) => group.map((node) => nodes[node]!).sort())
    .sort((a, b) => b.length - a.length);
};

/** The on-screen report: what was measured, and every group it found. */
export const formatCycleReport = (
  edges: Map<string, Set<string>>,
  groups: string[][],
): string => {
  const lines = [
    `modules with load-time imports: ${edges.size}`,
    `cyclic groups: ${groups.length}`,
    "",
    "Load-time edges only: type-only imports evaluate nothing and dynamic",
    "imports are deferred, so neither creates a load-order cycle.",
  ];
  for (const group of groups) {
    lines.push("", `== group of ${group.length} ==`);
    for (const member of group) lines.push(`  ${member}`);
  }
  return lines.join("\n");
};
