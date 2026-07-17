import { isAbsolute, relative } from "node:path";
import { filter, map, sort } from "#fp";
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

const normalizePath = (path: string): string => path.replace(/\\/g, "/");

const relativeToProject = (path: string): string => {
  const normalized = normalizePath(path);
  const projectPath = isAbsolute(normalized)
    ? relative(projectRoot, normalized)
    : normalized;
  return normalizePath(projectPath).replace(/^\.\//, "");
};

const testPrefix = (sourceFile: string): string =>
  relativeToProject(sourceFile)
    .replace(/^src\//, "test/")
    .replace(/\.(?:js|ts|tsx)$/, "");

const ownsTest = (prefix: string, testFile: string): boolean => {
  const base = relativeToProject(testFile).replace(/\.test\.(?:ts|tsx)$/, "");
  return base === prefix || base.startsWith(`${prefix}/`);
};

const isIntegrationTest = (testFile: string): boolean => {
  const path = relativeToProject(testFile);
  return (
    filter((prefix: string) => path.startsWith(prefix))(
      INTEGRATION_TEST_PREFIXES,
    ).length > 0
  );
};

interface OwnedTest {
  owner: string | null;
  testFile: string;
}

const chooseTestFiles =
  (keep: (test: OwnedTest) => boolean) =>
  (tests: OwnedTest[]): string[] =>
    map(({ testFile }: OwnedTest) => testFile)(filter(keep)(tests));

const ownedTest =
  (prefixes: string[]) =>
  (testFile: string): OwnedTest => ({
    owner:
      sort((a: string, b: string) => b.length - a.length)(
        filter((prefix: string) => ownsTest(prefix, testFile))(prefixes),
      )[0] ?? null,
    testFile,
  });

/** Pair selected sources with their mirrored tests. Only tests in the explicit
 * integration/e2e folders may remain unmatched. */
export const buildMutationTestMap = (
  sourceFiles: string[],
  testFiles: string[],
): MutationTestMap => {
  const sources = [...new Set(sourceFiles)];
  const tests = [...new Set(testFiles)];
  const prefixes = map(testPrefix)(sources);
  const ownedTests = map(ownedTest(prefixes))(tests);
  const misplaced = chooseTestFiles(
    ({ owner, testFile }) => owner === null && !isIntegrationTest(testFile),
  )(ownedTests);
  if (misplaced.length > 0) {
    throw new Error(
      "Mutation tests must mirror a selected source or live under " +
        `test/integration/ or test/e2e/:\n${map(relativeToProject)(misplaced).join("\n")}`,
    );
  }
  return {
    integrationTestFiles: chooseTestFiles(
      ({ owner, testFile }) => owner === null && isIntegrationTest(testFile),
    )(ownedTests),
    targets: map((sourceFile: string) => ({
      directTestFiles: chooseTestFiles(
        ({ owner }) => owner === testPrefix(sourceFile),
      )(ownedTests),
      sourceFile,
    }))(sources),
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
