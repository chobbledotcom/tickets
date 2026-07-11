#!/usr/bin/env -S deno run --allow-read=src,test,deno.json

/**
 * Unit-test coverage report — the thin shell.
 *
 * Walks `src/` and `test/`, counts lines, and prints which source files still
 * need a mirrored unit test, which existing tests are thinnest, and which test
 * files don't line up to a source file. See `unit-tests-report-lib.ts` for the
 * mirror convention and the pure logic; this file is just the filesystem and
 * argument wiring, so it is never imported by tests.
 *
 * Usage:
 *   deno task unit-tests-report            # top 25 of each list
 *   deno task unit-tests-report --all      # every entry
 *   deno task unit-tests-report --json     # machine-readable report
 */

import {
  findMisplacedTests,
  formatMisplacedSection,
  resolveImportToSource,
  resolveTestImports,
  type TestImports,
} from "./unit-tests-report-imports.ts";
import {
  buildReport,
  countLines,
  DEFAULT_LIMIT,
  DEFAULT_OPTIONS,
  type FileLines,
  formatReport,
  isSourcePath,
  isTestPath,
  toJsonReport,
} from "./unit-tests-report-lib.ts";
import { walkFiles } from "./walk-files.ts";

const collect = async (
  root: string,
  keep: (path: string) => boolean,
): Promise<FileLines[]> => {
  const files: FileLines[] = [];
  for await (const path of walkFiles(root)) {
    if (!keep(path)) continue;
    files.push({ lines: countLines(await Deno.readTextFile(path)), path });
  }
  return files;
};

/** The project's `#`-alias → target map, the input the import resolver needs. */
const readImportMap = async (): Promise<Record<string, string>> => {
  const config = JSON.parse(await Deno.readTextFile("deno.json"));
  return config.imports;
};

/** Every test file paired with the `src/` paths it imports. */
const collectTestImports = async (
  root: string,
  importMap: Record<string, string>,
  srcRoot: string,
): Promise<TestImports[]> => {
  const tests: TestImports[] = [];
  for await (const path of walkFiles(root)) {
    if (!isTestPath(path)) continue;
    const text = await Deno.readTextFile(path);
    tests.push({ imports: resolveTestImports(text, importMap, srcRoot), path });
  }
  return tests;
};

if (import.meta.main) {
  const args = new Set(Deno.args);
  const options = DEFAULT_OPTIONS;
  const importMap = await readImportMap();
  const sources = await collect(options.srcRoot, isSourcePath);
  const tests = await collect(options.testRoot, isTestPath);
  const testImports = await collectTestImports(
    options.testRoot,
    importMap,
    options.srcRoot,
  );
  const report = buildReport(sources, tests, options);
  // `#routes` is the app entry point; a test importing it is integration, not a
  // single-source unit, so it never counts as a misplaced mirror.
  const appEntry = resolveImportToSource(
    "#routes",
    importMap,
    options.srcRoot,
  )!;
  const misplaced = findMisplacedTests(
    testImports,
    sources.map((source) => source.path),
    options,
    appEntry,
  );

  if (args.has("--json")) {
    console.log(
      JSON.stringify({ ...toJsonReport(report), misplaced }, null, 2),
    );
  } else {
    const limit = args.has("--all") ? null : DEFAULT_LIMIT;
    console.log(
      [
        ...formatReport(report, limit),
        "",
        "Misplaced tests (import one source but live off its mirror — move them):",
        ...formatMisplacedSection(misplaced, limit),
      ].join("\n"),
    );
  }
}
