#!/usr/bin/env -S deno run --allow-all
/**
 * In-house mutation tester — "tests for your tests".
 *
 * Copies the checkout into `.mutation-runs/<id>/work`, mutates
 * binary/logical/assignment operators in the copied source file(s), runs the
 * mapped test file(s), and reports which mutants SURVIVED (were not caught by
 * any assertion). It is the real version of the heuristic in
 * `test-quality-audit.ts`: instead of guessing which assertions look weak, it
 * proves which code changes your tests fail to notice.
 *
 * The operator tables and AST walk are derived from Mutasaurus (MIT); the
 * execution model is our own. The child process still mutates in place inside
 * the copied checkout so import-map aliases bind to the mutant — see
 * scripts/mutation/LICENSE.mutasaurus.md.
 *
 * Usage: deno task mutation <source-glob> <test-glob> [options]
 */

import { globToRegExp, join, normalize, SEPARATOR } from "@std/path";
import { DEFAULT_TIMEOUT, parseArgs } from "./mutation/args.ts";
import { runIsolatedMutationCommand } from "./mutation/isolation.ts";
import {
  isSnapshotChild,
  runSnapshotChild,
} from "./mutation/snapshot-child.ts";

const USAGE = `Usage:
  deno task mutation <source-glob> <test-glob> [options]
  deno task mutation --source <glob> --test <glob> [--source …] [--test …]

Mutates operators in the source file(s), runs the mapped test file(s), and
reports which mutants survived (were NOT caught by your tests).

Options:
  --exhaustive     Try every operator replacement, not just one per operator.
  --harness        Build static assets and start stripe-mock first (needed for
                   tests that import the app / Stripe; slower).
  --jobs <n>       Concurrent test-file batches per mutant (default: CPU-aware,
                   or MUTATION_JOBS when set).
  --timeout <ms>   Per-mutant timeout floor (default ${DEFAULT_TIMEOUT}).
  -h, --help       Show this help.

Examples:
  deno task mutation src/shared/dates.ts test/shared/dates.test.ts
  deno task mutation 'src/shared/forms/definition.ts' 'test/shared/forms/definition/*.test.ts' --exhaustive`;

/** Glob metacharacters; a path segment with none is a fixed directory name. */
const GLOB_CHARS = /[*?{}[\]]/;

/** Every file under `dir`, recursively; a missing directory yields nothing. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return;
  }
  for await (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* walkFiles(path);
    else if (entry.isFile) yield path;
  }
}

/** The leading, glob-free directory of `glob` — where a walk can start without
 *  scanning the whole tree. An exact path (no metacharacters) returns itself. */
const staticBase = (glob: string): string => {
  const fixed: string[] = [];
  for (const segment of normalize(glob).split(SEPARATOR)) {
    if (GLOB_CHARS.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.length > 0 ? fixed.join(SEPARATOR) : ".";
};

/**
 * Expand source/test globs to absolute file paths. Replaces `@std/fs`'s
 * `expandGlob` (not in this project's lock, so unfetchable in a sandboxed run)
 * with `@std/path`'s `globToRegExp` over a `Deno.readDir` walk — same contract:
 * absolute paths to existing files, sorted and de-duplicated.
 */
const expand = async (globs: string[]): Promise<string[]> => {
  const cwd = Deno.cwd();
  const paths = new Set<string>();
  for (const glob of globs) {
    const absGlob = join(cwd, glob);
    const pattern = globToRegExp(absGlob, { extended: true, globstar: true });
    const base = staticBase(absGlob);
    try {
      if ((await Deno.stat(base)).isFile) {
        if (pattern.test(base)) paths.add(base);
        continue;
      }
    } catch {
      // base doesn't exist; the walk below simply yields nothing
    }
    for await (const path of walkFiles(base)) {
      if (pattern.test(path)) paths.add(path);
    }
  }
  return [...paths].sort();
};

const main = async (): Promise<void> => {
  const args = parseArgs(Deno.args);
  if (args.error !== null) {
    console.error(args.error);
    Deno.exit(1);
  }
  if (args.help || args.sources.length === 0 || args.tests.length === 0) {
    console.log(USAGE);
    Deno.exit(args.help ? 0 : 1);
  }

  const sourceFiles = await expand(args.sources);
  const testFiles = await expand(args.tests);
  if (sourceFiles.length === 0) {
    console.error("No source files matched.");
    Deno.exit(1);
  }
  if (testFiles.length === 0) {
    console.error("No test files matched.");
    Deno.exit(1);
  }

  const { runMutationTesting } = await import("./mutation/runner.ts");
  const code = await runMutationTesting({
    ...(args.batchJobs === undefined ? {} : { batchJobs: args.batchJobs }),
    exhaustive: args.exhaustive,
    sourceFiles,
    testFiles,
    timeout: args.timeout,
    useHarness: args.useHarness,
  });
  Deno.exit(code);
};

if (import.meta.main) {
  if (isSnapshotChild()) {
    await runSnapshotChild(main);
  } else {
    Deno.exit(await runIsolatedMutationCommand(Deno.args));
  }
}
