import { filter, map, sort, unique } from "#fp";
import { inProjectFolders, relativeToProject } from "#scripts/path.ts";
import { isFeaturePath } from "#scripts/specs/paths.ts";

export interface SourceTestTarget {
  directTestFiles: string[];
  sourceFile: string;
}

export interface MutationTestMap {
  integrationTestFiles: string[];
  targets: SourceTestTarget[];
}

const isIntegrationTest = inProjectFolders([
  "specs",
  "test/e2e",
  "test/integration",
]);
const isSharedSpecCode = inProjectFolders([
  "test/specs/steps",
  "test/specs/support",
]);

/** Where a source's tests live: `src/a/b.ts` mirrors to `test/a/b`, and a file
 *  in any other top-level folder (`scripts/`, `cli/`) mirrors to the same path
 *  under `test/`, so the repo's own tooling can be mutation-tested too. */
const testPrefix = (sourceFile: string): string => {
  const withoutExtension = relativeToProject(sourceFile).replace(
    /\.(?:js|ts|tsx)$/,
    "",
  );
  return withoutExtension.startsWith("src/")
    ? withoutExtension.replace(/^src\//, "test/")
    : `test/${withoutExtension}`;
};

const ownsTest = (prefix: string, testFile: string): boolean => {
  const base = relativeToProject(testFile).replace(/\.test\.(?:ts|tsx)$/, "");
  return base === prefix || base.startsWith(`${prefix}/`);
};

/** The `src/` files a test exercises — its own imports plus the ones its
 * helpers make on its behalf. `scripts/test-subjects.ts` computes these; the
 * default reports none, which leaves selection on the path mirror alone. */
export type SubjectsOf = (testFile: string) => readonly string[];

const NO_SUBJECTS: SubjectsOf = () => [];

/** Select every direct test for the changed sources, plus broad integration
 * tests changed on this branch. Changed shared Cucumber code selects every
 * Feature because any story may use it.
 *
 * A source with no test at its mirror falls back to the tests that exercise it
 * through a helper, so a source is never mutated with nothing to catch the
 * mutants merely because its test sits elsewhere. */
export const selectMutationTests = (
  sourceFiles: string[],
  allTestFiles: string[],
  changedTestFiles: string[],
  subjectsOf: SubjectsOf = NO_SUBJECTS,
): string[] => {
  const prefixes = map(testPrefix)(sourceFiles);
  const direct = filter(
    (testFile: string) =>
      !isIntegrationTest(testFile) &&
      prefixes.some((prefix) => ownsTest(prefix, testFile)),
  )(allTestFiles);
  const unmirrored = filter(
    (sourceFile: string) =>
      !direct.some((testFile) => ownsTest(testPrefix(sourceFile), testFile)),
  )(sourceFiles);
  const bySubject = filter(
    (testFile: string) =>
      !isIntegrationTest(testFile) &&
      unmirrored.some((sourceFile) =>
        subjectsOf(testFile).includes(sourceFile),
      ),
  )(unmirrored.length === 0 ? [] : allTestFiles);
  const changedIntegration = filter(isIntegrationTest)(changedTestFiles);
  const affectedFeatures = changedTestFiles.some(isSharedSpecCode)
    ? filter(isFeaturePath)(allTestFiles)
    : [];
  return unique([
    ...direct,
    ...bySubject,
    ...changedIntegration,
    ...affectedFeatures,
  ]);
};

interface OwnedTest {
  /** Every selected source's mirror prefix this test runs for. Empty means no
   *  selected source claims it (an integration test, or a stray). */
  owners: string[];
  testFile: string;
}

const chooseTestFiles =
  (keep: (test: OwnedTest) => boolean) =>
  (tests: OwnedTest[]): string[] =>
    map(({ testFile }: OwnedTest) => testFile)(filter(keep)(tests));

/** The mirror prefix that owns `testFile`, or null when no prefix does. The
 *  longest (most specific) match wins. */
const mirrorOwnerOrNull = (
  prefixes: string[],
  testFile: string,
): string | null =>
  sort((a: string, b: string) => b.length - a.length)(
    filter((prefix: string) => ownsTest(prefix, testFile))(prefixes),
  )[0] ?? null;

const ownedTest =
  (prefixes: string[], subjectsOf: SubjectsOf) =>
  (testFile: string): OwnedTest => {
    if (isIntegrationTest(testFile)) return { owners: [], testFile };
    const mirrored = mirrorOwnerOrNull(prefixes, testFile);
    if (mirrored !== null) return { owners: [mirrored], testFile };
    // No mirror: fall back to every source it exercises through its helpers, so
    // a test that proves two such sources runs for both of them.
    const exercised = filter((prefix: string) =>
      subjectsOf(testFile).some((source) => testPrefix(source) === prefix),
    )(prefixes);
    return { owners: exercised, testFile };
  };

/** Pair selected sources with their mirrored tests. Only explicit
 * integration/e2e/Cucumber paths may remain unmatched. */
export const buildMutationTestMap = (
  sourceFiles: string[],
  testFiles: string[],
  subjectsOf: SubjectsOf = NO_SUBJECTS,
): MutationTestMap => {
  const sources = [...new Set(sourceFiles)];
  const tests = [...new Set(testFiles)];
  const prefixes = map(testPrefix)(sources);
  const ownedTests = map(ownedTest(prefixes, subjectsOf))(tests);
  const misplaced = chooseTestFiles(
    ({ owners, testFile }) =>
      owners.length === 0 && !isIntegrationTest(testFile),
  )(ownedTests);
  if (misplaced.length > 0) {
    throw new Error(
      "Mutation tests must mirror a selected source or live under " +
        `specs/, test/integration/, or test/e2e/:\n${map(relativeToProject)(misplaced).join("\n")}`,
    );
  }
  return {
    integrationTestFiles: chooseTestFiles(
      ({ owners, testFile }) =>
        owners.length === 0 && isIntegrationTest(testFile),
    )(ownedTests),
    targets: map((sourceFile: string) => ({
      directTestFiles: chooseTestFiles(({ owners }) =>
        owners.includes(testPrefix(sourceFile)),
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
