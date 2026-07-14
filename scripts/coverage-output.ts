import { join } from "node:path";
import { rethrowUnlessNotFound } from "./not-found.ts";
import { projectRoot } from "./project-root.ts";

export const COVERAGE_OUTPUT_DIR = join(projectRoot, "coverage");

export const removeOldCoverageOutput = async (
  coverageDir = COVERAGE_OUTPUT_DIR,
): Promise<void> => {
  try {
    await Deno.remove(coverageDir, { recursive: true });
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
};
