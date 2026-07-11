/**
 * Unit-test coverage report — the pure core.
 *
 * The project is working towards a unit test (with 100% mutation coverage) for
 * every source file, on top of the integration/e2e tests that already exercise
 * the app end-to-end. This report measures progress towards that goal by a
 * simple, mechanical convention: a source file at `src/<path>.ts` is considered
 * to have a unit test when a test file lives at the *mirror* location under
 * `test/`, either as a single file or — when one source needs several test
 * files — inside a directory named after the source:
 *
 *   src/shared/accounting/store.ts   ->  test/shared/accounting/store.test.ts
 *                                    or  test/shared/accounting/store/*.test.ts
 *
 * From that one rule the report derives three things a human (or a future
 * agent) can act on directly:
 *
 *   1. Source files with no mirrored test at all — the untested list.
 *   2. Source files that *have* tests but a high source-lines-to-test-lines
 *      ratio — the thinly-tested list, a good place to add cases.
 *   3. Test files that don't sit at any source's mirror location — either a
 *      test for something that isn't a single source file, or a test that
 *      belongs somewhere else and should be moved.
 *
 * Everything here is a pure function of the file lists (path + line count) it is
 * handed; the walking and line-counting live in the thin shell
 * `scripts/unit-tests-report.ts`, so every rule below is unit-testable with
 * crafted inputs.
 */

import { filter, map, pipe, sort, sumOf } from "#fp";

/** A source or test file paired with its line count. */
export type FileLines = {
  path: string;
  lines: number;
};

/** How to read the tree and which files are exempt from the "needs a test"
 *  rule. Roots are configurable so the logic can be tested against a temp
 *  tree, and default to the real `src`/`test` roots. */
export type ReportOptions = {
  srcRoot: string;
  testRoot: string;
  /** Path prefixes under `src` that are not expected to have their own unit
   *  test (e.g. generated data, translation tables). */
  exemptSourcePrefixes: string[];
  /** Path prefixes under `test` that are not expected to mirror a source file
   *  (e.g. end-to-end suites, script tests, shared test helpers). */
  exemptTestPrefixes: string[];
};

/** A single source file enriched with the tests that cover it. */
export type SourceReport = {
  path: string;
  lines: number;
  /** Mirror-located test files covering this source, in path order. */
  testFiles: string[];
  /** Combined line count of `testFiles`. */
  testLines: number;
  tested: boolean;
  /** Source lines per test line — how thin the tests are. `Infinity` when the
   *  source has no test at all, so untested files always sort to the top. */
  ratio: number;
};

/** The whole report, ready to format or serialise. */
export type Report = {
  totalSources: number;
  testedCount: number;
  /** Untested source files, biggest first (the largest gap is the best
   *  target). */
  untested: SourceReport[];
  /** Tested source files, thinnest coverage first. */
  ranked: SourceReport[];
  /** Test files that don't sit at any source's mirror location. */
  orphanTests: string[];
};

/** Default roots and exemptions for a real run against this repo. */
export const DEFAULT_OPTIONS: ReportOptions = {
  // Translation tables are data, not logic, so they carry no unit test.
  exemptSourcePrefixes: ["src/locales/"],
  // These test trees exercise the app as a whole or test the tooling itself,
  // so they deliberately don't mirror a single source file.
  exemptTestPrefixes: [
    "test/e2e/",
    "test/integration/",
    "test/scripts/",
    "test/test-utils/",
    "test/setup.ts",
  ],
  srcRoot: "src",
  testRoot: "test",
};

/** Whether a path is on an exempt prefix (an exact match, or inside a
 *  `dir/`-style prefix). Shared with the import-attribution module. */
export const hasExemptPrefix = (path: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => path === prefix || path.startsWith(prefix));

/** Count non-blank lines, so whitespace padding doesn't inflate the ratio. */
export const countLines = (text: string): number =>
  text.split("\n").filter((line) => line.trim() !== "").length;

/** A `.ts`/`.tsx` file that isn't a type-declaration file. */
export const isSourcePath = (path: string): boolean =>
  (path.endsWith(".ts") || path.endsWith(".tsx")) && !path.endsWith(".d.ts");

/** A `.test.ts`/`.test.tsx` test file. */
export const isTestPath = (path: string): boolean =>
  path.endsWith(".test.ts") || path.endsWith(".test.tsx");

/** Whether a source file is one we expect to carry its own unit test. Type
 *  declaration files and anything on an exempt prefix are left out. */
export const isTestableSource = (
  path: string,
  options: ReportOptions,
): boolean =>
  !path.endsWith(".d.ts") &&
  !hasExemptPrefix(path, options.exemptSourcePrefixes);

/**
 * The mirror location a source file's test(s) must live at, with the source
 * root swapped for the test root and the extension dropped. A `src/a/b/name.ts`
 * maps to the prefix `test/a/b/name`, matched either as `<prefix>.test.ts(x)`
 * or as any file inside `<prefix>/`.
 */
export const mirrorPrefix = (
  srcPath: string,
  options: ReportOptions,
): string => {
  const withoutRoot = srcPath.slice(options.srcRoot.length + 1);
  const withoutExt = withoutRoot.replace(/\.(?:ts|tsx)$/, "");
  return `${options.testRoot}/${withoutExt}`;
};

/**
 * The mirror prefix of the source a test belongs to, or `null` when no source
 * owns it. A test at `test/a/b/name.test.ts` is owned by the source whose
 * mirror is the longest path-prefix of it that actually exists: its own direct
 * mirror `test/a/b/name` when `src/a/b/name.ts` exists, otherwise the nearest
 * ancestor directory that mirrors a source (the directory-suite convention).
 *
 * Picking the longest matching prefix is what stops a child's own mirror from
 * being counted against its parent: given both `src/db/attendees.ts` and
 * `src/db/attendees/kind.ts`, the test `test/db/attendees/kind.test.ts` matches
 * the child prefix `test/db/attendees/kind` (longer) over the parent
 * `test/db/attendees`, so it counts only for the child and never hides a
 * missing parent test. The trailing-slash check keeps a sibling like
 * `test/db/attendees-notes.test.ts` from matching the `test/db/attendees` prefix.
 */
export const owningSourcePrefix = (
  testPath: string,
  sourcePrefixes: Iterable<string>,
): string | null => {
  const base = testPath.replace(/\.test\.(?:ts|tsx)$/, "");
  let best: string | null = null;
  for (const prefix of sourcePrefixes) {
    const owns = base === prefix || base.startsWith(`${prefix}/`);
    if (owns && (best === null || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best;
};

/** Build the per-source view from the tests already assigned to it. */
const describeSource = (
  source: FileLines,
  ownedTests: FileLines[],
): SourceReport => {
  const testLines = sumOf((test: FileLines) => test.lines)(ownedTests);
  return {
    lines: source.lines,
    path: source.path,
    ratio:
      testLines === 0 ? Number.POSITIVE_INFINITY : source.lines / testLines,
    tested: ownedTests.length > 0,
    testFiles: pipe(
      map((test: FileLines) => test.path),
      sort((a: string, b: string) => a.localeCompare(b)),
    )(ownedTests),
    testLines,
  };
};

/** Biggest source file first — the largest untested file is the best target. */
const byLinesDesc = (a: SourceReport, b: SourceReport): number =>
  b.lines - a.lines || a.path.localeCompare(b.path);

/** Thinnest coverage first, then biggest source as a tie-breaker. */
const byRatioDesc = (a: SourceReport, b: SourceReport): number =>
  b.ratio - a.ratio || b.lines - a.lines || a.path.localeCompare(b.path);

/**
 * Fold the raw source and test file lists into the full report: which sources
 * are (un)tested, how thin the tested ones are, and which test files don't
 * mirror any source. Each non-exempt test is assigned to exactly one owning
 * source (its nearest mirror), so a test is never double-counted or credited to
 * a parent when it really covers a child.
 */
export const buildReport = (
  allSources: FileLines[],
  allTests: FileLines[],
  options: ReportOptions,
): Report => {
  const sources = filter((s: FileLines) => isTestableSource(s.path, options))(
    allSources,
  );
  // Pre-seed a bucket per source (keyed by its mirror prefix) so every owned
  // test lands in an existing list and every source has one to describe from.
  const prefixes = sources.map((s) => mirrorPrefix(s.path, options));
  const ownedTests = new Map<string, FileLines[]>(prefixes.map((p) => [p, []]));

  // Assign each non-exempt test to its owning source; the rest are orphans.
  // Exempt trees (e2e, integration, …) sit outside the mirror system entirely.
  const orphans: string[] = [];
  for (const test of allTests) {
    if (hasExemptPrefix(test.path, options.exemptTestPrefixes)) continue;
    const owner = owningSourcePrefix(test.path, prefixes);
    if (owner === null) orphans.push(test.path);
    else ownedTests.get(owner)!.push(test);
  }

  const described = sources.map((s, i) =>
    describeSource(s, ownedTests.get(prefixes[i]!)!),
  );

  return {
    orphanTests: sort((a: string, b: string) => a.localeCompare(b))(orphans),
    ranked: pipe(
      filter((s: SourceReport) => s.tested),
      sort(byRatioDesc),
    )(described),
    testedCount: filter((s: SourceReport) => s.tested)(described).length,
    totalSources: described.length,
    untested: pipe(
      filter((s: SourceReport) => !s.tested),
      sort(byLinesDesc),
    )(described),
  };
};

/** The single best file to write tests for next: the largest untested file if
 *  any remain, otherwise the thinnest-tested one. `null` only when every source
 *  is exempt (an empty tree). */
export const suggestedTarget = (report: Report): SourceReport | null =>
  report.untested[0] ?? report.ranked[0] ?? null;

/** A source entry shaped for JSON: `ratio` becomes `null` for untested files,
 *  because JSON has no infinity. The untested signal is still carried by
 *  `tested: false` and `testLines: 0`. */
export type JsonSourceReport = Omit<SourceReport, "ratio"> & {
  ratio: number | null;
};

/** The report shaped for JSON output. */
export type JsonReport = Omit<Report, "ranked" | "untested"> & {
  ranked: JsonSourceReport[];
  untested: JsonSourceReport[];
};

const toJsonSource = (source: SourceReport): JsonSourceReport => ({
  ...source,
  ratio: Number.isFinite(source.ratio) ? source.ratio : null,
});

/**
 * Convert a report to a JSON-safe shape. `JSON.stringify` turns the infinite
 * ratio of untested files into `null` on its own, but doing it here keeps the
 * numeric contract explicit (a `ratio` is a number or `null`, never a silently
 * dropped `Infinity`) rather than relying on that quirk.
 */
export const toJsonReport = (report: Report): JsonReport => ({
  ...report,
  ranked: report.ranked.map(toJsonSource),
  untested: report.untested.map(toJsonSource),
});

/* -------------------------------------------------------------------------- *
 * Formatting                                                                 *
 * -------------------------------------------------------------------------- */

/** How many rows each list shows before it is truncated, unless `--all`. */
export const DEFAULT_LIMIT = 25;

const pct = (part: number, whole: number): string =>
  whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1);

/** A ratio for display: `∞` for untested, else two decimals. */
export const formatRatio = (ratio: number): string =>
  ratio === Number.POSITIVE_INFINITY ? "∞" : ratio.toFixed(2);

const limitRows = <T>(rows: T[], limit: number | null): T[] =>
  limit === null ? rows : rows.slice(0, limit);

const truncationNote = (shown: number, total: number): string[] =>
  shown < total ? [`  … and ${total - shown} more (use --all to list)`] : [];

const untestedLines = (report: Report, limit: number | null): string[] => {
  if (report.untested.length === 0)
    return ["  (none — every source has a test)"];
  const shown = limitRows(report.untested, limit);
  return [
    ...shown.map((s) => `  ${String(s.lines).padStart(5)}  ${s.path}`),
    ...truncationNote(shown.length, report.untested.length),
  ];
};

const rankedLines = (report: Report, limit: number | null): string[] => {
  if (report.ranked.length === 0) return ["  (none)"];
  const shown = limitRows(report.ranked, limit);
  return [
    `  ${"ratio".padStart(6)}  ${"src".padStart(5)}  ${"test".padStart(5)}  file`,
    ...shown.map(
      (s) =>
        `  ${formatRatio(s.ratio).padStart(6)}  ${String(s.lines).padStart(
          5,
        )}  ${String(s.testLines).padStart(5)}  ${s.path}`,
    ),
    ...truncationNote(shown.length, report.ranked.length),
  ];
};

const orphanLines = (report: Report, limit: number | null): string[] => {
  if (report.orphanTests.length === 0) return ["  (none)"];
  const shown = limitRows(report.orphanTests, limit);
  return [
    ...shown.map((path) => `  ${path}`),
    ...truncationNote(shown.length, report.orphanTests.length),
  ];
};

/**
 * Render the report as plain text lines. `limit` caps each list (null shows
 * everything); the thinnest-tested and largest-untested files come first so the
 * top of each list is the best place to spend effort next.
 */
export const formatReport = (
  report: Report,
  limit: number | null,
): string[] => {
  const target = suggestedTarget(report);
  return [
    "Unit-test coverage report",
    "=========================",
    `Source files needing a test: ${report.totalSources}`,
    `  with a mirrored test:      ${report.testedCount} (${pct(
      report.testedCount,
      report.totalSources,
    )}%)`,
    `  untested:                  ${report.untested.length}`,
    `Orphan test files (mirror no source): ${report.orphanTests.length}`,
    "",
    target
      ? `👉 Suggested next target: ${target.path} (${
          target.tested
            ? `ratio ${formatRatio(target.ratio)}, ${target.lines} src / ${target.testLines} test lines`
            : `untested, ${target.lines} lines`
        })`
      : "👉 Nothing to do — no testable sources found.",
    "",
    "Untested source files (largest first):",
    ...untestedLines(report, limit),
    "",
    "Thinnest-tested source files (highest src:test ratio first):",
    ...rankedLines(report, limit),
    "",
    `Orphan test files (not at any source's mirror path):`,
    ...orphanLines(report, limit),
  ];
};
