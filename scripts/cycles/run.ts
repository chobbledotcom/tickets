/**
 * IO shell for the cycle report: reads the real module graph and returns the
 * report text. Kept thin so the graph logic stays testable.
 */

import { resolve } from "@std/path";
import { type ModuleGraph, readModuleGraph } from "#scripts/module-graph.ts";
import { cyclicGroups, formatCycleReport, loadTimeEdges } from "./graph.ts";

const ROOT_MODULE = "src/serve-app.ts";

/** Reads the module graph for `entry` from `cwd` — injectable so tests run
 * the report over fixtures without a `deno info` subprocess. */
export type GraphReader = (entry: string, cwd: string) => Promise<ModuleGraph>;

/** The full import-cycle report for the production entry point's graph. */
export const runCycleReport = async (
  readGraph: GraphReader = readModuleGraph,
): Promise<string> => {
  const repoRoot = resolve(import.meta.dirname!, "../..");
  const graph = await readGraph(ROOT_MODULE, repoRoot);
  const edges = loadTimeEdges(graph, repoRoot);
  return formatCycleReport(edges, cyclicGroups(edges));
};
