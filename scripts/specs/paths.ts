import { join } from "node:path";
import { inProjectFolders, relativeToProject } from "#scripts/path.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** Where a run leaves its reports for anyone who wants to read them after. */
export const SPEC_REPORT_DIR = join(projectRoot, "reports");

/** The files a run loads before it starts: the world it needs, then the steps. */
export const SPEC_SUPPORT_GLOBS = [
  "test/specs/support/**/*.ts",
  "test/specs/steps/**/*.ts",
];

export const isFeaturePath = (path: string): boolean =>
  relativeToProject(path).endsWith(".feature");

export const isSpecPath = inProjectFolders(["specs"]);
