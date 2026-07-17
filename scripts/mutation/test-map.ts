import { isAbsolute, relative, sep } from "node:path";
import { projectRoot } from "../project-root.ts";

export interface SourceTestTarget {
  directTestFiles: string[];
  sourceFile: string;
}

export interface MutationTestMap {
  integrationTestFiles: string[];
  targets: SourceTestTarget[];
}

const relativeToProject = (path: string): string =>
  isAbsolute(path) ? relative(projectRoot, path) : path.replace(/^\.\//, "");

const testPrefix = (sourceFile: string): string =>
  relativeToProject(sourceFile)
    .replace(/^src[/\\]/, `test${sep}`)
    .replace(/\.(?:js|ts|tsx)$/, "");

const ownsTest = (prefix: string, testFile: string): boolean => {
  const base = relativeToProject(testFile).replace(/\.test\.(?:ts|tsx)$/, "");
  return base === prefix || base.startsWith(`${prefix}${sep}`);
};

/** Pair selected sources with their mirrored tests. Tests with no selected
 * source mirror are integration tests and run only for direct-test survivors. */
export const buildMutationTestMap = (
  sourceFiles: string[],
  testFiles: string[],
): MutationTestMap => {
  const sources = [...new Set(sourceFiles)];
  const tests = [...new Set(testFiles)];
  const prefixes = sources.map(testPrefix);
  const owners = tests.map((testFile) => {
    const matches = prefixes.filter((prefix) => ownsTest(prefix, testFile));
    return matches.sort((a, b) => b.length - a.length)[0] ?? null;
  });
  return {
    integrationTestFiles: tests.filter((_, index) => owners[index] === null),
    targets: sources.map((sourceFile, index) => ({
      directTestFiles: tests.filter(
        (_, testIndex) => owners[testIndex] === prefixes[index],
      ),
      sourceFile,
    })),
  };
};
