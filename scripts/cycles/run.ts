/**
 * IO shell for the cycle report: reads the real module graph and returns the
 * report text. Kept thin so the graph logic stays testable.
 */

import { resolve } from "@std/path";
import { readModuleGraph } from "#scripts/module-graph.ts";
import { cyclicGroups, formatCycleReport, loadTimeEdges } from "./graph.ts";

const ROOT_MODULE = "src/serve-app.ts";

/** The full import-cycle report for the production entry point's graph. */
export const runCycleReport = async (): Promise<string> => {
  const repoRoot = resolve(import.meta.dirname!, "../..");
  const graph = await readModuleGraph(ROOT_MODULE, repoRoot);
  const edges = loadTimeEdges(graph, repoRoot);
  return formatCycleReport(edges, cyclicGroups(edges));
};
