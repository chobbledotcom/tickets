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

const INTEGRATION_TEST_PREFIXES = ["test/e2e/", "test/integration/"];

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

const isIntegrationTest = (testFile: string): boolean => {
  const path = relativeToProject(testFile);
  return INTEGRATION_TEST_PREFIXES.some((prefix) => path.startsWith(prefix));
};

/** Pair selected sources with their mirrored tests. Only tests in the explicit
 * integration/e2e folders may remain unmatched. */
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
  const misplaced = tests.filter(
    (testFile, index) => owners[index] === null && !isIntegrationTest(testFile),
  );
  if (misplaced.length > 0) {
    throw new Error(
      "Mutation tests must mirror a selected source or live under " +
        `test/integration/ or test/e2e/:\n${misplaced.map(relativeToProject).join("\n")}`,
    );
  }
  return {
    integrationTestFiles: tests.filter(
      (testFile, index) =>
        owners[index] === null && isIntegrationTest(testFile),
    ),
    targets: sources.map((sourceFile, index) => ({
      directTestFiles: tests.filter(
        (_, testIndex) => owners[testIndex] === prefixes[index],
      ),
      sourceFile,
    })),
  };
};

export const requireDirectMutationTests = (
  sourceFile: string,
  mutantCount: number,
  directTestFiles: string[],
): void => {
  if (mutantCount === 0 || directTestFiles.length > 0) return;
  throw new Error(
    `No direct test mirrors ${relativeToProject(sourceFile)}. ` +
      "Move its test to the matching path under test/.",
  );
};
