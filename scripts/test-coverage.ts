import { join } from "node:path";
import { projectRoot } from "./project-root.ts";

export const COVERAGE_DIR = join(projectRoot, "coverage");

export const clearCoverageDir = async (
  coverageDir = COVERAGE_DIR,
): Promise<void> => {
  try {
    await Deno.remove(coverageDir, { recursive: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
};
