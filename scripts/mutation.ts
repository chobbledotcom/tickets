#!/usr/bin/env -S deno run --allow-all
/**
 * In-house mutation tester — "tests for your tests".
 *
 * Mutates binary/logical/assignment operators in the given source file(s), runs the
 * mapped test file(s), and reports which mutants SURVIVED (were not caught by
 * any assertion). It is the real version of the heuristic in
 * `test-quality-audit.ts`: instead of guessing which assertions look weak, it
 * proves which code changes your tests fail to notice.
 *
 * The operator tables and AST walk are derived from Mutasaurus (MIT); the
 * execution model is our own — see scripts/mutation/LICENSE.mutasaurus.md.
 *
 * Usage: deno task mutation <source-glob> <test-glob> [options]
 */

import { expandGlob } from "jsr:@std/fs@^1.0.0";
import { runMutationTesting } from "./mutation/runner.ts";

const DEFAULT_TIMEOUT = 10_000;

const USAGE = `Usage:
  deno task mutation <source-glob> <test-glob> [options]
  deno task mutation --source <glob> --test <glob> [--source …] [--test …]

Mutates operators in the source file(s), runs the mapped test file(s), and
reports which mutants survived (were NOT caught by your tests).

Options:
  --exhaustive     Try every operator replacement, not just one per operator.
  --harness        Build static assets and start stripe-mock first (needed for
                   tests that import the app / Stripe; slower).
  --timeout <ms>   Per-mutant timeout floor (default ${DEFAULT_TIMEOUT}).
  -h, --help       Show this help.

Examples:
  deno task mutation src/shared/dates.ts test/lib/dates.test.ts
  deno task mutation 'src/lib/forms/*.ts' 'test/lib/forms/*.test.ts' --exhaustive`;

interface ParsedArgs {
  error: string | null;
  exhaustive: boolean;
  help: boolean;
  sources: string[];
  tests: string[];
  timeout: number;
  useHarness: boolean;
}

const parseArgs = (args: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    error: null,
    exhaustive: false,
    help: false,
    sources: [],
    tests: [],
    timeout: DEFAULT_TIMEOUT,
    useHarness: false,
  };
  const positional: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--exhaustive") parsed.exhaustive = true;
    else if (arg === "--harness") parsed.useHarness = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--source" && next !== undefined) {
      parsed.sources.push(next);
      index += 1;
    } else if (arg === "--test" && next !== undefined) {
      parsed.tests.push(next);
      index += 1;
    } else if (arg === "--timeout" && next !== undefined) {
      parsed.timeout = Number(next);
      index += 1;
    } else if (arg !== undefined) positional.push(arg);
    index += 1;
  }
  if (parsed.sources.length > 0 || parsed.tests.length > 0) {
    // Flag-form was used: positionals are not part of the grammar. Any leftover
    // means a glob expanded past the single value --source/--test consumed
    // (e.g. `--source src/*.ts` → src/a.ts src/b.ts …), which would silently
    // narrow the run. Reject rather than drop the extras.
    if (positional.length > 0) {
      const stray = positional.join(", ");
      parsed.error =
        `Unexpected positional argument(s) alongside --source/--test: ${stray}. ` +
        "A glob likely expanded to multiple files — quote it " +
        `(e.g. --source 'src/lib/forms/*.ts') or pass repeated --source/--test flags.`;
    }
  } else {
    if (positional[0] !== undefined) parsed.sources.push(positional[0]);
    if (positional[1] !== undefined) parsed.tests.push(positional[1]);
    if (positional.length > 2) {
      parsed.error =
        `Too many positional arguments (${positional.length}). Quote your globs ` +
        `so the shell can't expand them — e.g. 'src/lib/forms/*.ts' ` +
        `'test/lib/forms/*.test.ts' — or pass repeated --source/--test flags.`;
    }
  }
  if (!Number.isFinite(parsed.timeout) || parsed.timeout < 0) {
    parsed.error ??=
      "Invalid --timeout: expected a non-negative number of milliseconds.";
  }
  return parsed;
};

const expand = async (globs: string[]): Promise<string[]> => {
  const paths = new Set<string>();
  for (const glob of globs) {
    for await (const entry of expandGlob(glob, { root: Deno.cwd() })) {
      if (entry.isFile) paths.add(entry.path);
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

  const code = await runMutationTesting({
    exhaustive: args.exhaustive,
    sourceFiles,
    testFiles,
    timeout: args.timeout,
    useHarness: args.useHarness,
  });
  Deno.exit(code);
};

main();
