import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "#fp";
import { getAllFilesWithExt } from "#test/scripts/code-quality/detectors.ts";

/**
 * File discovery and scan plumbing for the code-quality rules: the in-scope
 * trees, the file lists, and the walkers that hand each file to a detector.
 * The live-tree assertions live in `test/integration/code-quality.test.ts`;
 * the detectors live in `detectors.ts`.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(currentDir, "../../..");
export const SRC_DIR = join(REPO_ROOT, "src");
const TEST_DIR = join(REPO_ROOT, "test");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const CLI_DIR = join(REPO_ROOT, "cli");
const E2E_PAYMENTS_DIR = join(REPO_ROOT, "e2e-payments");

/** The file lists and contents every rule reads. */
export type ScanContext = {
  srcFiles: string[];
  srcContents: Map<string, string>;
  testFiles: string[];
  testContents: Map<string, string>;
  /** Production `.tsx` templates — the templates the app actually renders.
   *  Passed to the production-only rules (test-only-exports, redundant-args)
   *  as additional production source. Stays scoped to `src/` so `.test.tsx`
   *  files under `test/` are never credited as production use. */
  srcTsxFiles: string[];
  srcTsxContents: Map<string, string>;
  /** Every `.tsx` file in every in-scope tree. Used by the parent-import rule
   *  (and any other rule that wants every template regardless of whether it's
   *  production code or a test). */
  allTsxFiles: string[];
  allTsxContents: Map<string, string>;
  /** Hand-written `.js`/`.jsx` files in every in-scope tree. Scanned by the
   *  parent-import rule so a script entry in `.js` cannot bypass it. */
  jsFiles: string[];
  jsContents: Map<string, string>;
  scriptsFiles: string[];
  scriptsContents: Map<string, string>;
  cliFiles: string[];
  cliContents: Map<string, string>;
  e2eFiles: string[];
  e2eContents: Map<string, string>;
};

const getAllTsFiles = (dir: string): Promise<string[]> =>
  getAllFilesWithExt(dir, ".ts");

/** `.js`/`.jsx` files in every in-scope tree (src, test, scripts, cli,
 *  e2e-payments) — hand-written browser source like
 *  `src/ui/client/scanner.js`, distinct from build artifacts. The
 *  parent-import rule scans these so a script entry cannot bypass it just by
 *  sitting in a `.js` file. {@link isBuildArtifactPath} filters out the
 *  `src/ui/static/` esbuild output and `dist/` edge bundle. */
const getAllJsFiles = async (): Promise<string[]> => {
  const dirs = [SRC_DIR, TEST_DIR, SCRIPTS_DIR, CLI_DIR, E2E_PAYMENTS_DIR];
  const exts = [".js", ".jsx"];
  const perDirExt = await Promise.all(
    dirs.flatMap((dir) => exts.map((ext) => getAllFilesWithExt(dir, ext))),
  );
  return perDirExt.flat().filter((f) => !isBuildArtifactPath(f));
};

/** `.tsx` files across every in-scope tree. The template-aware rules
 *  (parent-import is the first one) scan these in addition to the `.ts`
 *  lists so a `.tsx` file cannot bypass the rule by sitting outside `src/`. */
const getAllTsxFiles = async (): Promise<string[]> => {
  const dirs = [SRC_DIR, TEST_DIR, SCRIPTS_DIR, CLI_DIR, E2E_PAYMENTS_DIR];
  const perDir = await Promise.all(
    dirs.map((dir) => getAllFilesWithExt(dir, ".tsx")),
  );
  return perDir.flat();
};

/** Whether `fullPath` is a generated/build-output path (skipped by every
 *  source-scanning rule). `src/ui/static/` holds esbuild's bundled `.js`
 *  output (rebuilt from `.ts` by `scripts/build-static-assets.ts`) and
 *  `dist/` holds the bundled edge script, so neither is source. */
const isBuildArtifactPath = (fullPath: string): boolean =>
  fullPath.includes(`${sep}ui${sep}static${sep}`) ||
  fullPath.includes("/ui/static/") ||
  fullPath.includes(`${sep}dist${sep}`) ||
  fullPath.includes("/dist/");

/** Read all files once and cache contents in a Map keyed by path */
const readAllFiles = async (files: string[]): Promise<Map<string, string>> => {
  const entries = await Promise.all(
    files.map(async (f) => [f, await Deno.readTextFile(f)] as const),
  );
  return new Map(entries);
};

const loadScanContext = async (): Promise<ScanContext> => {
  const [src, test, srcTsx, allTsx, js, scripts, cli, e2e] = await Promise.all([
    getAllTsFiles(SRC_DIR),
    getAllTsFiles(TEST_DIR),
    getAllFilesWithExt(SRC_DIR, ".tsx"),
    getAllTsxFiles(),
    getAllJsFiles(),
    getAllTsFiles(SCRIPTS_DIR),
    getAllTsFiles(CLI_DIR),
    getAllTsFiles(E2E_PAYMENTS_DIR),
  ]);
  const [
    srcContents,
    testContents,
    srcTsxContents,
    allTsxContents,
    jsContents,
    scriptsContents,
    cliContents,
    e2eContents,
  ] = await Promise.all([
    readAllFiles(src),
    readAllFiles(test),
    readAllFiles(srcTsx),
    readAllFiles(allTsx),
    readAllFiles(js),
    readAllFiles(scripts),
    readAllFiles(cli),
    readAllFiles(e2e),
  ]);
  return {
    allTsxContents,
    allTsxFiles: allTsx,
    cliContents,
    cliFiles: cli,
    e2eContents,
    e2eFiles: e2e,
    jsContents,
    jsFiles: js,
    scriptsContents,
    scriptsFiles: scripts,
    srcContents,
    srcFiles: src,
    srcTsxContents,
    srcTsxFiles: srcTsx,
    testContents,
    testFiles: test,
  };
};

/** Cached file lists and contents, populated once on first use. */
export const ensureLoaded: () => Promise<ScanContext> = once(loadScanContext);

/**
 * Files that *define* the code-quality patterns (in comments, regexes and
 * fixture strings) and so would flag themselves under the line-level scans.
 * They have no real line-level violations of their own.
 */
const isCodeQualityFile = (relativePath: string): boolean =>
  relativePath === "test/integration/code-quality.test.ts" ||
  relativePath.startsWith("test/scripts/code-quality/");

export const getRelativePath = (fullPath: string): string =>
  fullPath.replace(`${SRC_DIR}/`, "");

/**
 * Path relative to the repo root, e.g. "src/foo.ts" or "test/foo.ts". Used by
 * the rules that scan both src and test files (aliasing, module-level let,
 * .then()) so their violation paths are unambiguous.
 */
const repoRelative = (fullPath: string): string =>
  fullPath.replace(`${REPO_ROOT}/`, "");

/** Iterate the in-scope files, skipping the code-quality folder's own
 *  fixtures (which legitimately use the patterns the rules forbid, e.g.
 *  `'import "../x.ts"'` as detector input). Each surviving file is handed to
 *  the caller alongside its repo-relative path and contents. */
const forEachScannedFile = (
  files: string[],
  contents: Map<string, string>,
  fn: (file: string, relativePath: string, fileContents: string) => void,
): void => {
  for (const file of files) {
    const relativePath = repoRelative(file);
    if (isCodeQualityFile(relativePath)) continue;
    fn(file, relativePath, contents.get(file)!);
  }
};

/**
 * Scan one file set line by line, collecting violations via a detector.
 * Skips code-quality's own files so its rule literals never self-flag.
 */
export const collectLineViolations = (
  files: string[],
  contents: Map<string, string>,
  detect: (
    relativePath: string,
    line: string,
    lineNum: number,
  ) => string | null,
): string[] => {
  const violations: string[] = [];
  forEachScannedFile(files, contents, (_file, relativePath, fileContents) => {
    const lines = fileContents.split("\n");
    let lineNum = 0;
    for (const line of lines) {
      lineNum++;
      const v = detect(relativePath, line, lineNum);
      if (v) violations.push(v);
    }
  });
  return violations;
};

/**
 * Scan src and test files line by line, collecting violations via a detector.
 * Test code is held to the same line-level standards as production code.
 * Returns the combined violation list.
 */
export const scanSourceLines = async (
  detect: (
    relativePath: string,
    line: string,
    lineNum: number,
  ) => string | null,
): Promise<string[]> => {
  const { srcFiles, srcContents, testFiles, testContents } =
    await ensureLoaded();
  return [
    ...collectLineViolations(srcFiles, srcContents, detect),
    ...collectLineViolations(testFiles, testContents, detect),
  ];
};

/** Run a whole-file detector (one call per file, receiving the full
 *  contents) over every in-scope tree. The detector returns every
 *  violation it finds in the file, so one call surfaces every form the
 *  rule forbids — single-line, multi-line, with comments in the gap —
 *  and a returned empty array means the file is clean. */
export const collectFileViolations = (
  files: string[],
  contents: Map<string, string>,
  detect: (relativePath: string, contents: string) => string[],
): string[] => {
  const violations: string[] = [];
  // Whole-file detectors (like detectRelativeImport) skip comments and
  // string literals themselves, so code-quality's own files do not need the
  // blanket skip the line-level detectors use — they cannot self-flag.
  for (const file of files) {
    const relativePath = repoRelative(file);
    violations.push(...detect(relativePath, contents.get(file)!));
  }
  return violations;
};

export const scanSourceFiles = async (
  detect: (relativePath: string, contents: string) => string[],
): Promise<string[]> => {
  const scan = await ensureLoaded();
  return [
    ...collectFileViolations(scan.srcFiles, scan.srcContents, detect),
    ...collectFileViolations(scan.testFiles, scan.testContents, detect),
    ...collectFileViolations(scan.allTsxFiles, scan.allTsxContents, detect),
    ...collectFileViolations(scan.jsFiles, scan.jsContents, detect),
    ...collectFileViolations(scan.scriptsFiles, scan.scriptsContents, detect),
    ...collectFileViolations(scan.cliFiles, scan.cliContents, detect),
    ...collectFileViolations(scan.e2eFiles, scan.e2eContents, detect),
  ];
};
