import { inProjectFolders, relativeToProject } from "#scripts/path.ts";

export const isFeaturePath = (path: string): boolean =>
  relativeToProject(path).endsWith(".feature");

export const isSpecPath = inProjectFolders(["specs"]);
