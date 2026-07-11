/**
 * Unit-test coverage report — import-based attribution.
 *
 * The path-mirror rule in `unit-tests-report-lib.ts` only sees a test as
 * covering a source when it *sits* at the mirror location. But this repo grew a
 * large legacy `test/lib/` tree whose files test `src/shared` and `src/features`
 * code from a path that mirrors nothing, so the path rule reports them as
 * orphans and their sources as untested. Reading what each test actually
 * `import`s recovers the real source→test link the paths have lost, and turns it
 * into an actionable list: a test that imports exactly one source but doesn't
 * live at that source's mirror is a file to *move* so the tree lines up.
 *
 * This module is pure: it resolves `#`-aliased import specifiers to `src/` paths
 * against a supplied import map, then folds the resolved test imports and the
 * source list into the misplaced-test worklist. The filesystem reads and the
 * import map itself come from the thin shell `unit-tests-report.ts`.
 */

import { sort } from "#fp";
import {
  hasExemptPrefix,
  isTestableSource,
  mirrorPrefix,
  owningSourcePrefix,
  type ReportOptions,
} from "./unit-tests-report-lib.ts";

/** A test file paired with the `src/` paths it imports, resolved from aliases. */
export type TestImports = {
  path: string;
  imports: string[];
};

/**
 * A test that imports exactly one source but does not live at that source's
 * mirror location — a candidate to move so `test/` lines up with `src/`.
 */
export type MisplacedTest = {
  test: string;
  source: string;
  /** The mirror location the test should move to (a `test/...` prefix). */
  suggestedPrefix: string;
  /** The test's own basename matches the source's, so it is very likely that
   *  source's real unit test rather than an integration test that merely
   *  imports it. Higher-confidence moves sort first. */
  basenameMatch: boolean;
};

/** Every `from "…"` specifier in a source text (static imports and re-exports). */
const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;

/** Pull the import/re-export specifiers out of a file's text. */
export const parseImportSpecifiers = (text: string): string[] =>
  [...text.matchAll(IMPORT_RE)].map((match) => match[1]!);

/** Whether `alias` maps `spec`: a directory alias (`#shared/`) owns anything
 *  beneath it; an exact alias (`#fp`) owns only the specifier itself. */
const aliasOwns = (alias: string, spec: string): boolean =>
  alias.endsWith("/") ? spec.startsWith(alias) : spec === alias;

/**
 * Resolve one import specifier to the `src/` path it refers to, or `null` when
 * it isn't a source import (a bare npm/jsr module, a `#test-utils/` helper, a
 * `#locales/` table). Directory aliases (`#shared/`) map their tail; exact
 * aliases (`#fp`, `#routes`) map the whole specifier. When several aliases own
 * the specifier, the longest (most specific) one wins — picked by a linear scan
 * so the result never depends on entry order.
 */
export const resolveImportToSource = (
  spec: string,
  importMap: Record<string, string>,
  srcRoot: string,
): string | null => {
  let best: { alias: string; target: string } | null = null;
  for (const [alias, rawTarget] of Object.entries(importMap)) {
    const target = rawTarget.replace(/^\.\//, "");
    if (!target.startsWith(`${srcRoot}/`)) continue;
    if (!aliasOwns(alias, spec)) continue;
    if (best === null || alias.length > best.alias.length)
      best = { alias, target };
  }
  if (best === null) return null;
  // Works for both alias kinds: an exact alias owns only `spec === alias`, so
  // its tail (`spec.slice(alias.length)`) is empty and this is just the target.
  return `${best.target}${spec.slice(best.alias.length)}`;
};

/** Every distinct `src/` path a test file imports, resolved from its text. */
export const resolveTestImports = (
  text: string,
  importMap: Record<string, string>,
  srcRoot: string,
): string[] => [
  ...new Set(
    parseImportSpecifiers(text)
      .map((spec) => resolveImportToSource(spec, importMap, srcRoot))
      .filter((path): path is string => path !== null),
  ),
];

/** The bare filename of a path, minus its extension and any `.test` marker, so a
 *  test's stem can be compared to its source's (`name.test.ts` ↔ `name.ts`). */
const stem = (path: string): string =>
  path
    .replace(/^.*\//, "")
    .replace(/\.test\.(?:ts|tsx)$/, "")
    .replace(/\.(?:ts|tsx)$/, "");

/** Sort weight: basename matches (rank 0) come before non-matches (rank 1). */
const confidenceRank = (entry: MisplacedTest): number =>
  entry.basenameMatch ? 0 : 1;

/** Higher-confidence (basename-matching) moves first, then by test path. Uses a
 *  symmetric rank difference so the order never depends on comparator call
 *  orientation. */
const byConfidence = (a: MisplacedTest, b: MisplacedTest): number =>
  confidenceRank(a) - confidenceRank(b) || a.test.localeCompare(b.test);

/**
 * The tests that import exactly one testable source but don't live at that
 * source's mirror — the reliable, reviewable list of files to move so the tree
 * lines up with `src/`. A test that imports the app entry point, or more than
 * one source, is left out: those are integration tests that mirror no single
 * source and belong under an exempt tree (`test/integration/`), not a move here.
 */
export const findMisplacedTests = (
  tests: TestImports[],
  sourcePaths: string[],
  options: ReportOptions,
  appEntry: string,
): MisplacedTest[] => {
  const testable = sourcePaths.filter((path) =>
    isTestableSource(path, options),
  );
  const sourceSet = new Set(testable);
  const prefixOf = new Map(
    testable.map((path) => [path, mirrorPrefix(path, options)]),
  );

  const misplaced: MisplacedTest[] = [];
  for (const test of tests) {
    if (hasExemptPrefix(test.path, options.exemptTestPrefixes)) continue;
    // Importing the app makes it an integration test, never a single-source unit.
    if (test.imports.includes(appEntry)) continue;
    const subjects = test.imports.filter((path) => sourceSet.has(path));
    if (subjects.length !== 1) continue;
    const source = subjects[0]!;
    const prefix = prefixOf.get(source)!;
    // Already sitting at (or inside) its source's mirror — nothing to move.
    if (owningSourcePrefix(test.path, [prefix]) === prefix) continue;
    misplaced.push({
      basenameMatch: stem(test.path) === stem(source),
      source,
      suggestedPrefix: prefix,
      test: test.path,
    });
  }
  return sort(byConfidence)(misplaced);
};

/** Render the misplaced-test worklist as plain text lines. `limit` caps the
 *  list (null shows everything); a ✓ marks a basename match. */
export const formatMisplacedSection = (
  misplaced: MisplacedTest[],
  limit: number | null,
): string[] => {
  if (misplaced.length === 0)
    return ["  (none — every unit test sits at its source's mirror)"];
  const shown = limit === null ? misplaced : misplaced.slice(0, limit);
  const lines = shown.map(
    (entry) =>
      `  ${entry.basenameMatch ? "✓" : " "} ${entry.test}\n      → ${entry.suggestedPrefix}  (imports ${entry.source})`,
  );
  const extra = misplaced.length - shown.length;
  return extra > 0
    ? [...lines, `  … and ${extra} more (use --all to list)`]
    : lines;
};
