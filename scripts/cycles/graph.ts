/**
 * The pure core of the import-cycle report: which modules a graph's
 * load-time edges hold in mutual reachability, and how to say that on
 * screen. Data in, data out — the `deno info` read lives in run.ts.
 */

import { relative } from "@std/path";
import {
  type ModuleGraph,
  staticCodeSpecifiers,
} from "#scripts/module-graph.ts";

/**
 * The load-time import edges of a graph: which local files under `root`
 * evaluate which others. Keyed and valued by paths relative to `root`.
 * Type-only imports evaluate nothing and dynamic imports are deferred to
 * first use, so neither is an edge — a cycle through either costs no cold
 * start and no load order.
 */
export const loadTimeEdges = (
  graph: ModuleGraph,
  root: string,
): Map<string, Set<string>> => {
  const edges = new Map<string, Set<string>>();
  const localUnderRoot = (specifier: string): string | null => {
    if (!specifier.startsWith("file://")) return null;
    const path = relative(root, specifier.replace("file://", ""));
    return path.startsWith("..") || path.startsWith("/") ? null : path;
  };
  for (const module of graph.modules) {
    const from = localUnderRoot(module.specifier);
    if (from === null) continue;
    for (const toSpecifier of staticCodeSpecifiers(module.dependencies ?? [])) {
      const to = localUnderRoot(toSpecifier);
      if (to === null || to === from) continue;
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
const finishOrderOf = (nodes: string[], adjacency: number[][]): number[] => {
  const seen = new Array<boolean>(nodes.length).fill(false);
  const finished: number[] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (seen[start]) continue;
    seen[start] = true;
    const stack: [number, number][] = [[start, 0]];
    while (stack.length > 0) {
      const [node, next] = stack[stack.length - 1]!;
      if (next < adjacency[node]!.length) {
        stack[stack.length - 1]![1] = next + 1;
        const target = adjacency[node]![next]!;
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
  transpose: number[][],
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
      for (const source of transpose[node]!) {
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
 * The groups of modules that can each load the other: strongly connected
 * components of more than one module, largest first, each member list
 * sorted. A group is a load-order tangle — any module in it pulls in every
 * other — and the count to work down is the group's size.
 */
export const cyclicGroups = (edges: Map<string, Set<string>>): string[][] => {
  const nodes = [
    ...new Set([
      ...edges.keys(),
      ...[...edges.values()].flatMap((targets) => [...targets]),
    ]),
  ];
  const index = new Map(nodes.map((node, i) => [node, i]));
  const adjacency = nodes.map((node) =>
    [...(edges.get(node) ?? [])]
      .filter((target) => index.has(target))
      .map((target) => index.get(target)!),
  );
  const transpose = nodes.map(() => [] as number[]);
  adjacency.forEach((targets, from) => {
    for (const to of targets) transpose[to]!.push(from);
  });
  return groupsFromFinishOrder(finishOrderOf(nodes, adjacency), transpose)
    .filter((group) => group.length > 1)
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
