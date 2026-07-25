import { isAbsolute, relative } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";

export const normalizePath = (path: string): string =>
  path.replaceAll("\\", "/");

export const relativeToProject = (path: string): string => {
  const normalized = normalizePath(path);
  const projectPath = isAbsolute(normalized)
    ? relative(projectRoot, normalized)
    : normalized;
  return normalizePath(projectPath).replace(/^\.\//, "");
};

export const inProjectFolders =
  (folders: readonly string[]) =>
  (path: string): boolean => {
    const relativePath = relativeToProject(path);
    return folders.some(
      (folder) =>
        relativePath === folder || relativePath.startsWith(`${folder}/`),
    );
  };
