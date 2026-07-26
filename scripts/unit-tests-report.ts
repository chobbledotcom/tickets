/**
 * Unit-test coverage report — the thin shell.
 * Run via `deno task unit-tests-report`, which grants
 * --allow-read=src,test,deno.json.
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

import { cachingReader, collectTestSubjects } from "./test-subjects.ts";
import {
  findMisplacedTests,
  formatMisplacedSection,
  resolveImportToSourceOrNull,
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

/** A test file with both its line count (for the ratio report) and the `src/`
 *  paths it exercises, its own and its helpers' (for the misplaced worklist). */
type TestFile = FileLines & TestImports;

/** Walk `root`, keep the files matching `keep`, and build a record from each
 *  file's path and text — read once. A shared walker for both trees: sources
 *  build a plain `FileLines`, tests also fold in their resolved imports. */
const collect = async <T extends FileLines>(
  root: string,
  keep: (path: string) => boolean,
  build: (path: string, text: string) => T,
): Promise<T[]> => {
  const files: T[] = [];
  for await (const path of walkFiles(root)) {
    if (!keep(path)) continue;
    files.push(build(path, await Deno.readTextFile(path)));
  }
  return files;
};

/** The project's `#`-alias → target map, the input the import resolver needs. */
const readImportMap = async (): Promise<Record<string, string>> => {
  const config = JSON.parse(await Deno.readTextFile("deno.json"));
  return config.imports;
};

if (import.meta.main) {
  const args = new Set(Deno.args);
  const options = DEFAULT_OPTIONS;
  const importMap = await readImportMap();
  const sources = await collect(
    options.srcRoot,
    isSourcePath,
    (path, text) => ({
      lines: countLines(text),
      path,
    }),
  );
  const readText = cachingReader((path: string) => Deno.readTextFile(path));
  const testTreeFiles = new Set<string>();
  for await (const path of walkFiles(options.testRoot)) testTreeFiles.add(path);
  const tests: TestFile[] = [];
  for (const path of testTreeFiles) {
    if (!isTestPath(path)) continue;
    tests.push({
      imports: await collectTestSubjects(
        path,
        readText,
        importMap,
        testTreeFiles,
      ),
      lines: countLines(await readText(path)),
      path,
    });
  }
  const report = buildReport(sources, tests, options);
  // `#routes` is the app entry point; a test importing it is integration, not a
  // single-source unit, so it never counts as a misplaced mirror.
  const appEntry = resolveImportToSourceOrNull(
    "#routes",
    importMap,
    options.srcRoot,
  )!;
  const misplaced = findMisplacedTests(
    tests,
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
