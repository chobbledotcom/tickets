import { join } from "node:path";
import { projectRoot } from "./project-root.ts";

export const COVERAGE_OUTPUT_DIR = join(projectRoot, "coverage");

export const removeOldCoverageOutput = async (
  coverageDir = COVERAGE_OUTPUT_DIR,
): Promise<void> => {
  try {
    await Deno.remove(coverageDir, { recursive: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
};
