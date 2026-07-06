#!/usr/bin/env -S deno run --allow-read=src,test
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
  buildReport,
  countLines,
  DEFAULT_LIMIT,
  DEFAULT_OPTIONS,
  type FileLines,
  formatReport,
  isSourcePath,
  isTestPath,
} from "./unit-tests-report-lib.ts";

async function* walkFiles(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkFiles(path);
      continue;
    }
    yield path;
  }
}

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

if (import.meta.main) {
  const args = new Set(Deno.args);
  const options = DEFAULT_OPTIONS;
  const sources = await collect(options.srcRoot, isSourcePath);
  const tests = await collect(options.testRoot, isTestPath);
  const report = buildReport(sources, tests, options);

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const limit = args.has("--all") ? null : DEFAULT_LIMIT;
    console.log(formatReport(report, limit).join("\n"));
  }
}
