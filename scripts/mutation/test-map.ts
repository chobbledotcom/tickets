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

/** The black-box tree: tests that know the app only through the driver. */
const isBlackboxFolder = inProjectFolders(["test/blackbox"]);

/** A black-box test file. The folder also holds the driver and its seeding
 * helpers, which are not tests. */
export const isBlackboxTest = (path: string): boolean =>
  isBlackboxFolder(path) && /\.test\.tsx?$/.test(path);

const isIntegrationTest = (path: string): boolean =>
  isBlackboxFolder(path) ||
  inProjectFolders(["specs", "test/e2e", "test/integration"])(path);
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

/** Select every direct test for the changed sources, plus broad integration
 * tests changed on this branch. Changed shared Cucumber code selects every
 * Feature because any story may use it.
 *
 * Selection is by the mirror path alone: a source whose test sits elsewhere is
 * reported as missing its direct suite (see `requireDirectMutationTests`) so
 * the test gets moved, rather than quietly running whatever reaches the source
 * through a shared helper. Every black-box test is selected too. It runs in the
 * integration stage, so it only runs for a mutant that the direct tests miss. */
export const selectMutationTests = (
  sourceFiles: string[],
  allTestFiles: string[],
  changedTestFiles: string[],
): string[] => {
  const prefixes = map(testPrefix)(sourceFiles);
  const direct = filter(
    (testFile: string) =>
      !isIntegrationTest(testFile) &&
      prefixes.some((prefix) => ownsTest(prefix, testFile)),
  )(allTestFiles);
  const changedIntegration = filter(isIntegrationTest)(changedTestFiles);
  const blackbox = filter(isBlackboxTest)(allTestFiles);
  const affectedFeatures = changedTestFiles.some(isSharedSpecCode)
    ? filter(isFeaturePath)(allTestFiles)
    : [];
  return unique([
    ...direct,
    ...changedIntegration,
    ...blackbox,
    ...affectedFeatures,
  ]);
};

interface OwnedTest {
  owner: string | null;
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
  (prefixes: string[]) =>
  (testFile: string): OwnedTest => ({
    owner: isIntegrationTest(testFile)
      ? null
      : mirrorOwnerOrNull(prefixes, testFile),
    testFile,
  });

/** Pair selected sources with their mirrored tests. Only explicit
 * integration/e2e/Cucumber paths may remain unmatched. */
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
        `specs/, test/integration/, or test/e2e/:\n${map(relativeToProject)(misplaced).join("\n")}`,
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

/** The black-box tests of a test map. */
export const blackboxTestsOf = (map: MutationTestMap): string[] =>
  filter(isBlackboxTest)(map.integrationTestFiles);

/** A source with mutants needs a mirror test, or the black-box tests. A source
 * that only the black-box tests cover must have every mutant killed by them:
 * the run fails on a survivor, as it does for any other source. */
export const requireDirectMutationTests = (
  sourceFile: string,
  mutantCount: number,
  directTestFiles: string[],
  blackboxTestFiles: string[],
): void => {
  if (
    mutantCount === 0 ||
    directTestFiles.length > 0 ||
    blackboxTestFiles.length > 0
  ) {
    return;
  }
  throw new Error(
    `No direct test mirrors ${relativeToProject(sourceFile)}. ` +
      "Move its test to the matching path under test/, or cover it in test/blackbox/.",
  );
};

/** Pair the sweep's sources with the direct tests that mirror them. Only
 * tests a source mirrors may enter, so an unrelated test file cannot fail
 * the strict map before the sweep starts. */
export const directTestMapFor = (
  sourceFiles: string[],
  allTestFiles: string[],
): Map<string, string[]> =>
  new Map(
    buildMutationTestMap(
      sourceFiles,
      selectMutationTests(sourceFiles, allTestFiles, []),
    ).targets.map((target) => [target.sourceFile, target.directTestFiles]),
  );
