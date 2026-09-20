/**
 * IO shell for the cycle gate: reads the real module graph and returns the
 * report text with the exit code the tree earns. Kept thin so the graph logic
 * stays testable.
 */

import { resolve } from "@std/path";
import { type ModuleGraph, readModuleGraph } from "#scripts/module-graph.ts";
import { cyclicGroups, formatCycleReport, loadTimeEdges } from "./graph.ts";

const ROOT_MODULE = "src/serve-app.ts";

/** Reads the module graph for `entry` from `cwd` — injectable so tests run
 * the gate over fixtures without a `deno info` subprocess. */
type GraphReader = (entry: string, cwd: string) => Promise<ModuleGraph>;

/** The import-cycle gate for the production entry point's graph: the full
 * report text, plus the exit code — non-zero while any cyclic group stands,
 * zero once the tree holds none. */
export const runCycleGate = async (
  readGraph: GraphReader = readModuleGraph,
): Promise<{ exitCode: number; text: string }> => {
  const repoRoot = resolve(import.meta.dirname!, "../..");
  const graph = await readGraph(ROOT_MODULE, repoRoot);
  const edges = loadTimeEdges(graph, repoRoot);
  const groups = cyclicGroups(edges);
  return {
    exitCode: groups.length === 0 ? 0 : 1,
    text: formatCycleReport(edges, groups),
  };
};
