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
import { runIsolatedMutationCommand } from "./mutation/isolation.ts";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_WORK_ROOT_ENV,
  withMutationRunLock,
} from "./mutation/isolation-state.ts";

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
  --jobs <n>       Concurrent test-file batches per mutant (default: CPU-aware,
                   or MUTATION_JOBS when set).
  --timeout <ms>   Per-mutant timeout floor (default ${DEFAULT_TIMEOUT}).
  -h, --help       Show this help.

Examples:
  deno task mutation src/shared/dates.ts test/lib/dates.test.ts
  deno task mutation 'src/lib/forms/*.ts' 'test/lib/forms/*.test.ts' --exhaustive`;

interface ParsedArgs {
  error: string | null;
  batchJobs?: number;
  exhaustive: boolean;
  help: boolean;
  sources: string[];
  tests: string[];
  timeout: number;
  useHarness: boolean;
}

type ValueFlagApply = (parsed: ParsedArgs, value: string) => void;

/** Options that take a value; maps the flag to how it records `next` on `parsed`. */
const VALUE_FLAGS: Record<string, ValueFlagApply | undefined> = {
  "--jobs": (parsed, value) => {
    parsed.batchJobs = Number(value);
  },
  "--source": (parsed, value) => parsed.sources.push(value),
  "--test": (parsed, value) => parsed.tests.push(value),
  "--timeout": (parsed, value) => {
    parsed.timeout = Number(value);
  },
};

/**
 * Apply a single argument to `parsed` (or collect it as positional). Returns
 * true when it also consumed `next` as the flag's value.
 */
const applyArg = (
  parsed: ParsedArgs,
  positional: string[],
  arg: string,
  next: string | undefined,
): boolean => {
  if (arg === "--exhaustive") parsed.exhaustive = true;
  else if (arg === "--harness") parsed.useHarness = true;
  else if (arg === "-h" || arg === "--help") parsed.help = true;
  else if (VALUE_FLAGS[arg] !== undefined && next !== undefined) {
    VALUE_FLAGS[arg]?.(parsed, next);
    return true;
  } else positional.push(arg);
  return false;
};

/** Fold positional arguments into `parsed`, recording an error on misuse. */
const applyPositionals = (parsed: ParsedArgs, positional: string[]): void => {
  const usedFlagForm = parsed.sources.length > 0 || parsed.tests.length > 0;
  if (usedFlagForm) {
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
    return;
  }
  if (positional[0] !== undefined) parsed.sources.push(positional[0]);
  if (positional[1] !== undefined) parsed.tests.push(positional[1]);
  if (positional.length > 2) {
    parsed.error =
      `Too many positional arguments (${positional.length}). Quote your globs ` +
      `so the shell can't expand them — e.g. 'src/lib/forms/*.ts' ` +
      `'test/lib/forms/*.test.ts' — or pass repeated --source/--test flags.`;
  }
};

/** Validate the parsed numeric options, recording the first error found. */
const validateNumericArgs = (parsed: ParsedArgs): void => {
  if (!Number.isFinite(parsed.timeout) || parsed.timeout < 0) {
    parsed.error ??=
      "Invalid --timeout: expected a non-negative number of milliseconds.";
  }
  const invalidJobs =
    parsed.batchJobs !== undefined &&
    (!Number.isInteger(parsed.batchJobs) || parsed.batchJobs <= 0);
  if (invalidJobs) {
    parsed.error ??= "Invalid --jobs: expected a positive integer.";
  }
};

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
    if (arg !== undefined) {
      const consumedNext = applyArg(parsed, positional, arg, args[index + 1]);
      if (consumedNext) index += 1;
    }
    index += 1;
  }
  applyPositionals(parsed, positional);
  validateNumericArgs(parsed);
  return parsed;
};

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

const mutationRunRootFromEnv = (): string | null => {
  const id = Deno.env.get(MUTATION_RUN_ID_ENV);
  const runRoot = Deno.env.get(MUTATION_RUN_ROOT_ENV);
  const workRoot = Deno.env.get(MUTATION_WORK_ROOT_ENV);
  return id && runRoot && workRoot ? runRoot : null;
};

const runSnapshotChild = async (): Promise<void> => {
  const runRoot = mutationRunRootFromEnv();
  return runRoot === null
    ? await main()
    : await withMutationRunLock(runRoot, main);
};

if (import.meta.main) {
  if (Deno.env.get(MUTATION_SNAPSHOT_CHILD_ENV) === "1") {
    await runSnapshotChild();
  } else {
    Deno.exit(await runIsolatedMutationCommand(Deno.args));
  }
}
